import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendEntry = path.resolve(__dirname, '../../backend/index.js');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function waitForOutput(process, text, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`서버 준비 시간 초과: ${text}`)), timeoutMs);
    const onData = chunk => {
      if (!chunk.toString().includes(text)) return;
      clearTimeout(timer);
      process.stdout.off('data', onData);
      resolve();
    };
    process.stdout.on('data', onData);
  });
}

function once(socket, event, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`소켓 이벤트 시간 초과: ${event}`));
    }, timeoutMs);
    const onEvent = payload => {
      clearTimeout(timer);
      resolve(payload);
    };
    socket.once(event, onEvent);
  });
}

test('방 구성원끼리 WebRTC 연결 협상을 중계한다', async t => {
  const port = await getFreePort();
  const backend = spawn(process.execPath, [backendEntry], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sockets = [];

  t.after(() => {
    for (const socket of sockets) socket.disconnect();
    backend.kill('SIGTERM');
  });

  await waitForOutput(backend, `0.0.0.0:${port}`);

  const url = `http://127.0.0.1:${port}`;
  const options = { transports: ['websocket'], autoConnect: false, reconnection: false };
  const host = io(url, options);
  const controller = io(url, options);
  const stranger = io(url, options);
  sockets.push(host, controller, stranger);

  const hostConnected = once(host, 'connect');
  host.connect();
  await hostConnected;
  const roomCreated = once(host, 'room_created');
  host.emit('create_room');
  const roomId = await roomCreated;

  const controllerConnected = once(controller, 'connect');
  controller.connect();
  await controllerConnected;
  const playerJoined = once(host, 'player_joined');
  controller.emit('join_room', { roomId });
  const { playerId, color } = await playerJoined;

  const duplicatePlayerJoins = [];
  const recordDuplicateJoin = payload => duplicatePlayerJoins.push(payload);
  host.on('player_joined', recordDuplicateJoin);
  const duplicateJoined = once(controller, 'joined');
  controller.emit('join_room', { roomId });
  assert.deepEqual(await duplicateJoined, { roomId, color });
  await new Promise(resolve => setTimeout(resolve, 50));
  host.off('player_joined', recordDuplicateJoin);
  assert.deepEqual(duplicatePlayerJoins, []);

  const validOrientation = { alpha: 12.5, beta: 91.25, gamma: -4.5 };
  const firstRelayedOrientation = once(host, 'player_orientation');
  controller.emit('orientation', { roomId, data: null, sequence: 0 });
  controller.emit('orientation', {
    roomId,
    data: { alpha: 12.5, beta: 'invalid', gamma: -4.5 },
    sequence: 1,
  });
  controller.emit('orientation', {
    roomId,
    data: { ...validOrientation, padding: 'x'.repeat(8_192) },
    sequence: 2,
  });
  assert.deepEqual(await firstRelayedOrientation, {
    playerId,
    data: validOrientation,
    sequence: 2,
  });

  const burstOrientationSequences = [];
  const countBurstOrientation = payload => {
    burstOrientationSequences.push(payload.sequence);
  };
  host.on('player_orientation', countBurstOrientation);
  for (let index = 0; index < 1_000; index += 1) {
    controller.emit('orientation', {
      roomId,
      data: validOrientation,
      sequence: index + 3,
    });
  }
  await new Promise(resolve => setTimeout(resolve, 100));
  host.off('player_orientation', countBurstOrientation);
  assert.ok(burstOrientationSequences.length > 0);
  assert.ok(
    burstOrientationSequences.length <= 10,
    `relayed ${burstOrientationSequences.length} burst orientations`
  );
  assert.equal(burstOrientationSequences.at(-1), 1_002);

  const strangerConnected = once(stranger, 'connect');
  stranger.connect();
  await strangerConnected;
  const injectedSignals = {
    offers: 0,
    answers: 0,
    hostCandidates: 0,
    controllerCandidates: 0,
  };
  const countInjectedOffer = () => { injectedSignals.offers += 1; };
  const countInjectedAnswer = () => { injectedSignals.answers += 1; };
  const countInjectedHostCandidate = () => { injectedSignals.hostCandidates += 1; };
  const countInjectedControllerCandidate = () => { injectedSignals.controllerCandidates += 1; };
  controller.on('webrtc_offer', countInjectedOffer);
  host.on('webrtc_answer', countInjectedAnswer);
  controller.on('webrtc_host_candidate', countInjectedHostCandidate);
  host.on('webrtc_controller_candidate', countInjectedControllerCandidate);
  stranger.emit('webrtc_offer', {
    roomId,
    playerId,
    offer: { type: 'offer', sdp: 'unauthorized-offer' },
  });
  stranger.emit('webrtc_answer', {
    roomId,
    answer: { type: 'answer', sdp: 'unauthorized-answer' },
  });
  stranger.emit('webrtc_host_candidate', {
    roomId,
    playerId,
    candidate: { candidate: 'unauthorized-host-candidate' },
  });
  stranger.emit('webrtc_controller_candidate', {
    roomId,
    candidate: { candidate: 'unauthorized-controller-candidate' },
  });
  controller.emit('webrtc_offer', {
    roomId,
    playerId,
    offer: { type: 'offer', sdp: 'controller-cannot-offer' },
  });
  controller.emit('webrtc_host_candidate', {
    roomId,
    playerId,
    candidate: { candidate: 'controller-cannot-send-host-candidate' },
  });
  host.emit('webrtc_answer', {
    roomId,
    answer: { type: 'answer', sdp: 'host-cannot-answer' },
  });
  host.emit('webrtc_controller_candidate', {
    roomId,
    candidate: { candidate: 'host-cannot-send-controller-candidate' },
  });
  host.emit('webrtc_offer', {
    roomId,
    playerId,
    offer: { type: 'offer', sdp: 'x'.repeat(65_537) },
  });
  controller.emit('webrtc_answer', {
    roomId,
    answer: { type: 'answer', sdp: 'x'.repeat(65_537) },
  });
  host.emit('webrtc_host_candidate', {
    roomId,
    playerId,
    candidate: { candidate: 'x'.repeat(4_097) },
  });
  controller.emit('webrtc_controller_candidate', {
    roomId,
    candidate: { candidate: 'x'.repeat(4_097) },
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  controller.off('webrtc_offer', countInjectedOffer);
  host.off('webrtc_answer', countInjectedAnswer);
  controller.off('webrtc_host_candidate', countInjectedHostCandidate);
  host.off('webrtc_controller_candidate', countInjectedControllerCandidate);
  assert.deepEqual(injectedSignals, {
    offers: 0,
    answers: 0,
    hostCandidates: 0,
    controllerCandidates: 0,
  });

  const offer = { type: 'offer', sdp: 'host-offer' };
  const relayedOffer = once(controller, 'webrtc_offer');
  host.emit('webrtc_offer', { roomId, playerId, offer });
  assert.deepEqual(await relayedOffer, { offer });

  const answer = { type: 'answer', sdp: 'controller-answer' };
  const relayedAnswer = once(host, 'webrtc_answer');
  controller.emit('webrtc_answer', { roomId, answer });
  assert.deepEqual(await relayedAnswer, { playerId, answer });

  const hostCandidate = { candidate: 'host-candidate', sdpMid: '0', sdpMLineIndex: 0 };
  const relayedHostCandidate = once(controller, 'webrtc_host_candidate');
  host.emit('webrtc_host_candidate', { roomId, playerId, candidate: hostCandidate });
  assert.deepEqual(await relayedHostCandidate, { candidate: hostCandidate });

  const controllerCandidate = { candidate: 'controller-candidate', sdpMid: '0', sdpMLineIndex: 0 };
  const relayedControllerCandidate = once(host, 'webrtc_controller_candidate');
  controller.emit('webrtc_controller_candidate', { roomId, candidate: controllerCandidate });
  assert.deepEqual(await relayedControllerCandidate, { playerId, candidate: controllerCandidate });

  let burstCandidateCount = 0;
  const countBurstCandidate = () => { burstCandidateCount += 1; };
  host.on('webrtc_controller_candidate', countBurstCandidate);
  for (let index = 0; index < 1_000; index += 1) {
    controller.emit('webrtc_controller_candidate', {
      roomId,
      candidate: { candidate: `burst-candidate-${index}` },
    });
  }
  await new Promise(resolve => setTimeout(resolve, 100));
  host.off('webrtc_controller_candidate', countBurstCandidate);
  assert.ok(burstCandidateCount > 0);
  assert.ok(burstCandidateCount <= 128, `relayed ${burstCandidateCount} burst candidates`);

  const immediateOrientation = once(host, 'player_orientation');
  controller.emit('orientation', { roomId, data: validOrientation, sequence: 2_000 });
  assert.equal((await immediateOrientation).sequence, 2_000);
  const orientationsAfterDisconnect = [];
  const recordOrientationAfterDisconnect = payload => orientationsAfterDisconnect.push(payload.sequence);
  host.on('player_orientation', recordOrientationAfterDisconnect);
  controller.emit('orientation', { roomId, data: validOrientation, sequence: 2_001 });
  controller.disconnect();
  await new Promise(resolve => setTimeout(resolve, 50));
  host.off('player_orientation', recordOrientationAfterDisconnect);
  assert.equal(orientationsAfterDisconnect.includes(2_001), false);
});
