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

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // --- HOST EVENTS ---
  socket.on('create_room', () => {
    const { roomId } = createRoom(rooms, socket.id);
    socket.join(roomId);
    socket.emit('room_created', roomId);
    console.log(`Host ${socket.id} created room ${roomId}`);
  });

  socket.on('replace_room', ({ roomId }) => {
    const replacement = replaceRoom(rooms, socket.id, roomId);
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
  socket.on('join_room', ({ roomId }) => {
    roomId = roomId.toUpperCase();
    const room = rooms.get(roomId);

    if (room) {
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
  socket.on('calibration_started', ({ roomId }) => {
    const room = rooms.get(roomId?.toUpperCase());
    if (!room?.players[socket.id]) return;

    room.players[socket.id].calibrated = false;
    io.to(room.hostId).emit('player_calibration_started', { playerId: socket.id });
  });

  socket.on('calibration_completed', ({ roomId }) => {
    const room = rooms.get(roomId?.toUpperCase());
    if (!room?.players[socket.id]) return;

    room.players[socket.id].calibrated = true;
    io.to(room.hostId).emit('player_calibration_completed', { playerId: socket.id });
  });

  // Receive orientation data from controller and relay to host
  socket.on('orientation', ({ roomId, data }) => {
    const room = rooms.get(roomId?.toUpperCase());
    if (room?.players[socket.id]) {
      // Orientation is real-time state, not a command: never queue stale frames.
      io.to(room.hostId).volatile.emit('player_orientation', { playerId: socket.id, data });
    }
  });

  // A hit is a discrete game command, so deliver it reliably only from the
  // room's host to the controller that actually destroyed the obstacle.
  socket.on('player_hit', ({ roomId, playerId }) => {
    const room = rooms.get(roomId?.toUpperCase());
    if (room?.hostId === socket.id && room.players[playerId]) {
      io.to(playerId).emit('hit_feedback');
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);

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
