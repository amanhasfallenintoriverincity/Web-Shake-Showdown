const express = require('express');
const http = require('http');
const path = require('node:path');
const { Server } = require('socket.io');
const { mountProductionFrontend } = require('./productionFrontend');
const { createRoom, replaceRoom } = require('./roomManager');
const { createSocketRequestAuthorizer, parseAllowedOrigins } = require('./socketOrigin');

const app = express();
mountProductionFrontend(app, {
  distPath: process.env.FRONTEND_DIST_PATH || path.resolve(__dirname, '../frontend/dist'),
});

const server = http.createServer(app);
const configuredSocketOrigins = parseAllowedOrigins(process.env.SOCKET_ALLOWED_ORIGINS);
const socketServerOptions = {
  allowRequest: createSocketRequestAuthorizer(),
  maxHttpBufferSize: 70 * 1024,
};

// Local Vite development uses a permissive WebSocket policy. Production is
// same-origin by default and only enables cross-origin CORS when explicitly set.
if (process.env.NODE_ENV !== 'production' || configuredSocketOrigins.length > 0) {
  socketServerOptions.cors = {
    origin:
      process.env.NODE_ENV !== 'production' || configuredSocketOrigins.includes('*')
        ? '*'
        : configuredSocketOrigins,
    methods: ['GET', 'POST'],
  };
}

const io = new Server(server, socketServerOptions);

// Store active rooms and players
const rooms = new Map(); // roomId -> { hostId: string, players: { [socketId]: { color, connected } } }

const normalizeSocketPayload = (payload) => (
  payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
);
const normalizeRoomId = (roomId) => (typeof roomId === 'string' ? roomId.toUpperCase() : '');
const normalizeOrientation = (data) => {
  if (
    data === null
    || typeof data !== 'object'
    || !Number.isFinite(data.alpha)
    || !Number.isFinite(data.beta)
    || !Number.isFinite(data.gamma)
  ) return null;
  return { alpha: data.alpha, beta: data.beta, gamma: data.gamma };
};
const isValidOrientationSequence = (sequence) => (
  Number.isInteger(sequence) && sequence >= 0 && sequence <= 0xffffffff
);
const ORIENTATION_RELAY_INTERVAL_MS = 1000 / 60;
const SIGNALING_WINDOW_MS = 10_000;
const MAX_SIGNALING_EVENTS_PER_WINDOW = 128;
const emitOrientation = (socket, payload) => {
  const room = rooms.get(payload.roomId);
  if (!room?.players[socket.id]) return;
  io.to(room.hostId).volatile.emit('player_orientation', {
    playerId: socket.id,
    data: payload.data,
    sequence: payload.sequence,
  });
};
const queueOrientationRelay = (socket, payload) => {
  const now = Date.now();
  let state = socket.data.orientationRelayState;
  if (!state) {
    state = { lastSentAt: 0, pending: null, timer: null };
    socket.data.orientationRelayState = state;
  }

  const elapsed = now - state.lastSentAt;
  if (!state.timer && elapsed >= ORIENTATION_RELAY_INTERVAL_MS) {
    state.lastSentAt = now;
    emitOrientation(socket, payload);
    return;
  }

  state.pending = payload;
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    const latest = state.pending;
    state.pending = null;
    if (!latest) return;
    state.lastSentAt = Date.now();
    emitOrientation(socket, latest);
  }, Math.max(0, ORIENTATION_RELAY_INTERVAL_MS - elapsed));
};
const clearOrientationRelay = (socket) => {
  const state = socket.data.orientationRelayState;
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  delete socket.data.orientationRelayState;
};
const consumeSignalingBudget = (socket) => {
  const now = Date.now();
  let budget = socket.data.signalingBudget;
  if (!budget || now - budget.startedAt >= SIGNALING_WINDOW_MS) {
    budget = { startedAt: now, count: 0 };
    socket.data.signalingBudget = budget;
  }
  if (budget.count >= MAX_SIGNALING_EVENTS_PER_WINDOW) return false;
  budget.count += 1;
  return true;
};
const MAX_SDP_LENGTH = 65_536;
const MAX_ICE_CANDIDATE_LENGTH = 4_096;
const MAX_ICE_METADATA_LENGTH = 256;
const normalizeSessionDescription = (description, expectedType) => {
  if (
    description?.type !== expectedType
    || typeof description.sdp !== 'string'
    || description.sdp.length > MAX_SDP_LENGTH
  ) return null;
  return { type: expectedType, sdp: description.sdp };
};
const normalizeIceCandidate = (candidate) => {
  if (
    candidate === null
    || typeof candidate !== 'object'
    || Array.isArray(candidate)
    || typeof candidate.candidate !== 'string'
    || candidate.candidate.length > MAX_ICE_CANDIDATE_LENGTH
  ) return null;

  const normalized = { candidate: candidate.candidate };
  if (candidate.sdpMid !== undefined) {
    if (
      candidate.sdpMid !== null
      && (typeof candidate.sdpMid !== 'string'
        || candidate.sdpMid.length > MAX_ICE_METADATA_LENGTH)
    ) return null;
    normalized.sdpMid = candidate.sdpMid;
  }
  if (candidate.sdpMLineIndex !== undefined) {
    if (
      candidate.sdpMLineIndex !== null
      && (!Number.isInteger(candidate.sdpMLineIndex)
        || candidate.sdpMLineIndex < 0
        || candidate.sdpMLineIndex > 65_535)
    ) return null;
    normalized.sdpMLineIndex = candidate.sdpMLineIndex;
  }
  if (candidate.usernameFragment !== undefined) {
    if (
      candidate.usernameFragment !== null
      && (typeof candidate.usernameFragment !== 'string'
        || candidate.usernameFragment.length > MAX_ICE_METADATA_LENGTH)
    ) return null;
    normalized.usernameFragment = candidate.usernameFragment;
  }
  return normalized;
};

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // --- HOST EVENTS ---
  socket.on('create_room', () => {
    const { roomId } = createRoom(rooms, socket.id);
    socket.join(roomId);
    socket.emit('room_created', roomId);
    console.log(`Host ${socket.id} created room ${roomId}`);
  });

  socket.on('replace_room', (rawPayload) => {
    const { roomId } = normalizeSocketPayload(rawPayload);
    const replacement = replaceRoom(rooms, socket.id, normalizeRoomId(roomId));
    if (!replacement) return;

    socket.leave(replacement.previousRoomId);
    for (const playerId of replacement.playerIds) {
      io.to(playerId).emit('game_ended');
      io.sockets.sockets.get(playerId)?.leave(replacement.previousRoomId);
    }

    socket.join(replacement.roomId);
    socket.emit('room_created', replacement.roomId);
    console.log(
      `Host ${socket.id} replaced room ${replacement.previousRoomId} with ${replacement.roomId}`
    );
  });

  // --- CONTROLLER EVENTS ---
  socket.on('join_room', (rawPayload) => {
    const { roomId: rawRoomId } = normalizeSocketPayload(rawPayload);
    const roomId = normalizeRoomId(rawRoomId);
    const room = rooms.get(roomId);

    if (room) {
      const existingPlayer = room.players[socket.id];
      if (existingPlayer) {
        socket.join(roomId);
        socket.emit('joined', { roomId, color: existingPlayer.color });
        return;
      }

      // Assign a color based on the number of players
      const playerColors = ['#ff0055', '#00ffcc', '#ffcc00', '#cc00ff'];
      const playerKeys = Object.keys(room.players);
      const color = playerColors[playerKeys.length % playerColors.length];

      room.players[socket.id] = { color, connected: true, calibrated: false };
      socket.join(roomId);

      // Notify controller of success
      socket.emit('joined', { roomId, color });

      // Notify host of new player
      io.to(room.hostId).emit('player_joined', { playerId: socket.id, color });
      console.log(`Player ${socket.id} joined room ${roomId}`);
    } else {
      socket.emit('room_error', '게임 방을 찾을 수 없습니다. QR 코드를 다시 스캔해주세요.');
    }
  });

  // Keep the computer and phone alignment guides synchronized. Only a controller
  // that belongs to the room may change its own calibration state.
  socket.on('calibration_started', (rawPayload) => {
    const { roomId } = normalizeSocketPayload(rawPayload);
    const room = rooms.get(normalizeRoomId(roomId));
    if (!room?.players[socket.id]) return;

    room.players[socket.id].calibrated = false;
    io.to(room.hostId).emit('player_calibration_started', { playerId: socket.id });
  });

  socket.on('calibration_completed', (rawPayload) => {
    const { roomId } = normalizeSocketPayload(rawPayload);
    const room = rooms.get(normalizeRoomId(roomId));
    if (!room?.players[socket.id]) return;

    room.players[socket.id].calibrated = true;
    io.to(room.hostId).emit('player_calibration_completed', { playerId: socket.id });
  });

  // Receive orientation data from controller and relay to host
  socket.on('orientation', (rawPayload) => {
    const { roomId, data, sequence } = normalizeSocketPayload(rawPayload);
    const normalizedRoomId = normalizeRoomId(roomId);
    const room = rooms.get(normalizedRoomId);
    const normalizedOrientation = normalizeOrientation(data);
    if (
      room?.players[socket.id]
      && normalizedOrientation
      && isValidOrientationSequence(sequence)
    ) {
      // Keep one latest pending state instead of queueing stale sensor history.
      queueOrientationRelay(socket, {
        roomId: normalizedRoomId,
        data: normalizedOrientation,
        sequence,
      });
    }
  });

  // Socket.IO only negotiates the direct WebRTC path. High-rate orientation data
  // travels through the resulting peer-to-peer data channel, not through Render.
  socket.on('webrtc_offer', (rawPayload) => {
    if (!consumeSignalingBudget(socket)) return;
    const { roomId, playerId, offer } = normalizeSocketPayload(rawPayload);
    const room = rooms.get(normalizeRoomId(roomId));
    const normalizedOffer = normalizeSessionDescription(offer, 'offer');
    if (
      room?.hostId === socket.id
      && room.players[playerId]
      && normalizedOffer
    ) {
      io.to(playerId).emit('webrtc_offer', { offer: normalizedOffer });
    }
  });

  socket.on('webrtc_answer', (rawPayload) => {
    if (!consumeSignalingBudget(socket)) return;
    const { roomId, answer } = normalizeSocketPayload(rawPayload);
    const room = rooms.get(normalizeRoomId(roomId));
    const normalizedAnswer = normalizeSessionDescription(answer, 'answer');
    if (
      room?.players[socket.id]
      && normalizedAnswer
    ) {
      io.to(room.hostId).emit('webrtc_answer', {
        playerId: socket.id,
        answer: normalizedAnswer,
      });
    }
  });

  socket.on('webrtc_host_candidate', (rawPayload) => {
    if (!consumeSignalingBudget(socket)) return;
    const { roomId, playerId, candidate } = normalizeSocketPayload(rawPayload);
    const room = rooms.get(normalizeRoomId(roomId));
    const normalizedCandidate = normalizeIceCandidate(candidate);
    if (
      room?.hostId === socket.id
      && room.players[playerId]
      && normalizedCandidate
    ) {
      io.to(playerId).emit('webrtc_host_candidate', { candidate: normalizedCandidate });
    }
  });

  socket.on('webrtc_controller_candidate', (rawPayload) => {
    if (!consumeSignalingBudget(socket)) return;
    const { roomId, candidate } = normalizeSocketPayload(rawPayload);
    const room = rooms.get(normalizeRoomId(roomId));
    const normalizedCandidate = normalizeIceCandidate(candidate);
    if (room?.players[socket.id] && normalizedCandidate) {
      io.to(room.hostId).emit('webrtc_controller_candidate', {
        playerId: socket.id,
        candidate: normalizedCandidate,
      });
    }
  });

  // A hit is a discrete game command, so deliver it reliably only from the
  // room's host to the controller that actually destroyed the obstacle.
  socket.on('player_hit', (rawPayload) => {
    const { roomId, playerId } = normalizeSocketPayload(rawPayload);
    const room = rooms.get(normalizeRoomId(roomId));
    if (room?.hostId === socket.id && room.players[playerId]) {
      io.to(playerId).emit('hit_feedback');
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    clearOrientationRelay(socket);

    // Check if it was a host
    for (const [roomId, room] of rooms.entries()) {
      if (room.hostId === socket.id) {
        // Host disconnected, close room
        io.to(roomId).emit('host_disconnected');
        rooms.delete(roomId);
        console.log(`Room ${roomId} closed due to host disconnect`);
      } else if (room.players[socket.id]) {
        // Player disconnected
        delete room.players[socket.id];
        io.to(room.hostId).emit('player_left', { playerId: socket.id });
        console.log(`Player ${socket.id} left room ${roomId}`);
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : PORT;
  console.log(`Server listening on 0.0.0.0:${boundPort}`);
});
