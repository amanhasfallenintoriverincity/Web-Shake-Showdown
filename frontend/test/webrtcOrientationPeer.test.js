import assert from 'node:assert/strict';
import test from 'node:test';
import { createOrientationPublisher } from '../src/orientationTransport.js';

class FakeDataChannel {
  constructor(label, options) {
    this.label = label;
    this.options = options;
    this.readyState = 'connecting';
    this.closed = false;
    this.closeCalls = 0;
  }

  close() {
    this.closeCalls += 1;
    this.closed = true;
    this.readyState = 'closed';
  }
}

function createPeerHarness() {
  const peers = [];

  class FakePeerConnection {
    constructor(configuration) {
      this.configuration = configuration;
      this.connectionState = 'new';
      this.remoteDescription = null;
      peers.push(this);
    }

    createDataChannel(label, options) {
      this.channel = new FakeDataChannel(label, options);
      return this.channel;
    }

    async createOffer() {
      return { type: 'offer', sdp: 'host-offer' };
    }

    async createAnswer() {
      return { type: 'answer', sdp: 'controller-answer' };
    }

    async setLocalDescription(description) {
      this.localDescription = description;
    }

    async setRemoteDescription(description) {
      this.remoteDescription = description;
    }

    async addIceCandidate(candidate) {
      if (!this.addedCandidates) this.addedCandidates = [];
      this.addedCandidates.push(candidate);
    }

    close() {
      this.closeCalls = (this.closeCalls ?? 0) + 1;
      this.closed = true;
      this.connectionState = 'closed';
    }
  }

  return { FakePeerConnection, peers };
}

function createDeferred() {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test('host peer offers an unreliable orientation channel to one controller', async () => {
  const { createHostOrientationPeer } = await import('../src/webrtcOrientationPeer.js');
  const { FakePeerConnection, peers } = createPeerHarness();
  const socketEvents = [];
  const socket = {
    emit(event, payload) { socketEvents.push({ event, payload }); },
  };

  const session = createHostOrientationPeer({
    RTCPeerConnectionClass: FakePeerConnection,
    socket,
    roomId: 'ABCD',
    playerId: 'player-1',
    onOrientation() {},
  });
  await session.start();

  assert.equal(peers.length, 1);
  assert.equal(session.channel.label, 'orientation');
  assert.deepEqual(session.channel.options, { ordered: false, maxRetransmits: 0 });
  assert.equal(session.channel.binaryType, 'arraybuffer');
  assert.deepEqual(socketEvents, [{
    event: 'webrtc_offer',
    payload: {
      roomId: 'ABCD',
      playerId: 'player-1',
      offer: { type: 'offer', sdp: 'host-offer' },
    },
  }]);
});

test('host peer stops offer negotiation when close wins an in-flight await', async () => {
  const { createHostOrientationPeer } = await import('../src/webrtcOrientationPeer.js');
  const { FakePeerConnection } = createPeerHarness();
  const createdOffer = createDeferred();
  let setLocalDescriptionCalls = 0;

  class DelayedPeerConnection extends FakePeerConnection {
    async createOffer() {
      this.offerStarted = true;
      return createdOffer.promise;
    }

    async setLocalDescription(description) {
      setLocalDescriptionCalls += 1;
      return super.setLocalDescription(description);
    }
  }

  const socketEvents = [];
  const session = createHostOrientationPeer({
    RTCPeerConnectionClass: DelayedPeerConnection,
    socket: { emit(event, payload) { socketEvents.push({ event, payload }); } },
    roomId: 'ABCD',
    playerId: 'player-1',
    onOrientation() {},
  });

  const starting = session.start();
  assert.equal(session.peer.offerStarted, true);
  session.close();
  createdOffer.resolve({ type: 'offer', sdp: 'host-offer' });
  await starting;

  assert.equal(setLocalDescriptionCalls, 0);
  assert.deepEqual(socketEvents, []);
});

test('host peer accepts only the newest binary orientation packet', async () => {
  const { createHostOrientationPeer } = await import('../src/webrtcOrientationPeer.js');
  const { FakePeerConnection } = createPeerHarness();
  const received = [];
  const session = createHostOrientationPeer({
    RTCPeerConnectionClass: FakePeerConnection,
    socket: { emit() {} },
    roomId: 'ABCD',
    playerId: 'player-1',
    onOrientation(data, sequence) { received.push({ data, sequence }); },
  });

  const packets = [];
  const outboundChannel = {
    readyState: 'open',
    bufferedAmount: 0,
    send(packet) { packets.push(packet); },
  };
  let now = 0;
  const publish = createOrientationPublisher({ now: () => now });
  publish(null, 'ABCD', { alpha: 10, beta: 80, gamma: -2 }, outboundChannel);
  now = 17;
  publish(null, 'ABCD', { alpha: 20, beta: 90, gamma: 3 }, outboundChannel);

  session.channel.onmessage({ data: packets[1] });
  session.channel.onmessage({ data: packets[0] });

  assert.deepEqual(received, [{
    data: { alpha: 20, beta: 90, gamma: 3 },
    sequence: 1,
  }]);
});

test('host peer holds controller ICE until the answer is installed', async () => {
  const { createHostOrientationPeer } = await import('../src/webrtcOrientationPeer.js');
  const { FakePeerConnection } = createPeerHarness();
  const session = createHostOrientationPeer({
    RTCPeerConnectionClass: FakePeerConnection,
    socket: { emit() {} },
    roomId: 'ABCD',
    playerId: 'player-1',
    onOrientation() {},
  });
  const candidate = { candidate: 'controller-candidate', sdpMid: '0', sdpMLineIndex: 0 };

  await session.addCandidate(candidate);
  assert.equal(session.peer.addedCandidates, undefined);

  const answer = { type: 'answer', sdp: 'controller-answer' };
  await session.acceptAnswer(answer);

  assert.deepEqual(session.peer.remoteDescription, answer);
  assert.deepEqual(session.peer.addedCandidates, [candidate]);
});

test('host peer caps controller ICE queued before the answer', async () => {
  const { createHostOrientationPeer } = await import('../src/webrtcOrientationPeer.js');
  const { FakePeerConnection } = createPeerHarness();
  const session = createHostOrientationPeer({
    RTCPeerConnectionClass: FakePeerConnection,
    socket: { emit() {} },
    roomId: 'ABCD',
    playerId: 'player-1',
    onOrientation() {},
  });
  const candidates = Array.from({ length: 66 }, (_, index) => ({ candidate: `candidate-${index}` }));

  for (const candidate of candidates) {
    await session.addCandidate(candidate);
  }
  await session.acceptAnswer({ type: 'answer', sdp: 'controller-answer' });

  assert.equal(session.peer.addedCandidates.length, 64);
  assert.deepEqual(session.peer.addedCandidates, candidates.slice(0, 64));
});

test('host peer caps total controller ICE after the answer', async () => {
  const { createHostOrientationPeer } = await import('../src/webrtcOrientationPeer.js');
  const { FakePeerConnection } = createPeerHarness();
  const session = createHostOrientationPeer({
    RTCPeerConnectionClass: FakePeerConnection,
    socket: { emit() {} },
    roomId: 'ABCD',
    playerId: 'player-1',
    onOrientation() {},
  });
  await session.acceptAnswer({ type: 'answer', sdp: 'controller-answer' });
  const candidates = Array.from({ length: 66 }, (_, index) => ({ candidate: `candidate-${index}` }));

  for (const candidate of candidates) await session.addCandidate(candidate);

  assert.equal(session.peer.addedCandidates.length, 64);
  assert.deepEqual(session.peer.addedCandidates, candidates.slice(0, 64));
});

test('host peer shares one ICE cap across pre- and post-answer candidates', async () => {
  const { createHostOrientationPeer } = await import('../src/webrtcOrientationPeer.js');
  const { FakePeerConnection } = createPeerHarness();
  const session = createHostOrientationPeer({
    RTCPeerConnectionClass: FakePeerConnection,
    socket: { emit() {} },
    roomId: 'ABCD',
    playerId: 'player-1',
    onOrientation() {},
  });
  const candidates = Array.from({ length: 66 }, (_, index) => ({ candidate: `candidate-${index}` }));
  for (const candidate of candidates.slice(0, 32)) await session.addCandidate(candidate);
  await session.acceptAnswer({ type: 'answer', sdp: 'controller-answer' });
  for (const candidate of candidates.slice(32)) await session.addCandidate(candidate);

  assert.equal(session.peer.addedCandidates.length, 64);
  assert.deepEqual(session.peer.addedCandidates, candidates.slice(0, 64));
});

test('host peer does not flush queued ICE after closing during answer setup', async () => {
  const { createHostOrientationPeer } = await import('../src/webrtcOrientationPeer.js');
  const { FakePeerConnection } = createPeerHarness();
  const remoteDescription = createDeferred();

  class DelayedPeerConnection extends FakePeerConnection {
    async setRemoteDescription(description) {
      this.remoteDescriptionStarted = true;
      await remoteDescription.promise;
      this.remoteDescription = description;
    }
  }

  const session = createHostOrientationPeer({
    RTCPeerConnectionClass: DelayedPeerConnection,
    socket: { emit() {} },
    roomId: 'ABCD',
    playerId: 'player-1',
    onOrientation() {},
  });
  await session.addCandidate({ candidate: 'queued-candidate' });

  const acceptingAnswer = session.acceptAnswer({ type: 'answer', sdp: 'controller-answer' });
  assert.equal(session.peer.remoteDescriptionStarted, true);
  session.close();
  remoteDescription.resolve();
  await acceptingAnswer;

  assert.equal(session.peer.addedCandidates, undefined);
});

test('host peer signals gathered ICE only to its controller', async () => {
  const { createHostOrientationPeer } = await import('../src/webrtcOrientationPeer.js');
  const { FakePeerConnection } = createPeerHarness();
  const socketEvents = [];
  const session = createHostOrientationPeer({
    RTCPeerConnectionClass: FakePeerConnection,
    socket: { emit(event, payload) { socketEvents.push({ event, payload }); } },
    roomId: 'ABCD',
    playerId: 'player-1',
    onOrientation() {},
  });
  const candidate = { candidate: 'host-candidate', sdpMid: '0', sdpMLineIndex: 0 };

  session.peer.onicecandidate({ candidate });
  session.peer.onicecandidate({ candidate: null });

  assert.deepEqual(socketEvents, [{
    event: 'webrtc_host_candidate',
    payload: { roomId: 'ABCD', playerId: 'player-1', candidate },
  }]);
});

test('host peer close is idempotent and disconnects late callbacks', async () => {
  const { createHostOrientationPeer } = await import('../src/webrtcOrientationPeer.js');
  const { FakePeerConnection } = createPeerHarness();
  const socketEvents = [];
  const orientations = [];
  const session = createHostOrientationPeer({
    RTCPeerConnectionClass: FakePeerConnection,
    socket: { emit(event, payload) { socketEvents.push({ event, payload }); } },
    roomId: 'ABCD',
    playerId: 'player-1',
    onOrientation(data) { orientations.push(data); },
  });
  const handleIceCandidate = session.peer.onicecandidate;
  const handleMessage = session.channel.onmessage;
  const packets = [];
  const publish = createOrientationPublisher({ now: () => 0 });
  publish(null, 'ABCD', { alpha: 10, beta: 20, gamma: 30 }, {
    readyState: 'open',
    bufferedAmount: 0,
    send(packet) { packets.push(packet); },
  });

  session.close();
  session.close();

  assert.equal(session.peer.onicecandidate, null);
  assert.equal(session.channel.onmessage, null);
  assert.equal(session.peer.closeCalls, 1);
  assert.equal(session.channel.closeCalls, 1);

  handleIceCandidate({ candidate: { candidate: 'late-host-candidate' } });
  handleMessage({ data: packets[0] });
  assert.deepEqual(socketEvents, []);
  assert.deepEqual(orientations, []);
});

test('controller peer completes an offered orientation channel', async () => {
  const { createControllerOrientationPeer } = await import('../src/webrtcOrientationPeer.js');
  const { FakePeerConnection } = createPeerHarness();
  const socketEvents = [];
  const channels = [];
  const session = createControllerOrientationPeer({
    RTCPeerConnectionClass: FakePeerConnection,
    socket: { emit(event, payload) { socketEvents.push({ event, payload }); } },
    roomId: 'ABCD',
    onChannel(channel) { channels.push(channel); },
  });
  const offer = { type: 'offer', sdp: 'host-offer' };

  await session.acceptOffer(offer);
  const channel = new FakeDataChannel('orientation', {});
  session.peer.ondatachannel({ channel });

  assert.deepEqual(session.peer.remoteDescription, offer);
  assert.deepEqual(session.peer.localDescription, {
    type: 'answer',
    sdp: 'controller-answer',
  });
  assert.equal(channel.binaryType, 'arraybuffer');
  assert.deepEqual(channels, [channel]);
  assert.deepEqual(socketEvents, [{
    event: 'webrtc_answer',
    payload: {
      roomId: 'ABCD',
      answer: { type: 'answer', sdp: 'controller-answer' },
    },
  }]);
});

test('controller peer stops offer negotiation when close wins an in-flight await', async () => {
  const { createControllerOrientationPeer } = await import('../src/webrtcOrientationPeer.js');
  const { FakePeerConnection } = createPeerHarness();
  const remoteDescription = createDeferred();
  let createAnswerCalls = 0;

  class DelayedPeerConnection extends FakePeerConnection {
    async setRemoteDescription(description) {
      this.remoteDescriptionStarted = true;
      await remoteDescription.promise;
      this.remoteDescription = description;
    }

    async createAnswer() {
      createAnswerCalls += 1;
      return super.createAnswer();
    }
  }

  const socketEvents = [];
  const session = createControllerOrientationPeer({
    RTCPeerConnectionClass: DelayedPeerConnection,
    socket: { emit(event, payload) { socketEvents.push({ event, payload }); } },
    roomId: 'ABCD',
    onChannel() {},
  });

  const acceptingOffer = session.acceptOffer({ type: 'offer', sdp: 'host-offer' });
  assert.equal(session.peer.remoteDescriptionStarted, true);
  session.close();
  remoteDescription.resolve();
  await acceptingOffer;

  assert.equal(createAnswerCalls, 0);
  assert.deepEqual(socketEvents, []);
});

test('controller peer holds host ICE until the offer is installed', async () => {
  const { createControllerOrientationPeer } = await import('../src/webrtcOrientationPeer.js');
  const { FakePeerConnection } = createPeerHarness();
  const session = createControllerOrientationPeer({
    RTCPeerConnectionClass: FakePeerConnection,
    socket: { emit() {} },
    roomId: 'ABCD',
    onChannel() {},
  });
  const candidate = { candidate: 'host-candidate', sdpMid: '0', sdpMLineIndex: 0 };

  await session.addCandidate(candidate);
  assert.equal(session.peer.addedCandidates, undefined);

  await session.acceptOffer({ type: 'offer', sdp: 'host-offer' });

  assert.deepEqual(session.peer.addedCandidates, [candidate]);
});

test('controller peer caps host ICE queued before the offer', async () => {
  const { createControllerOrientationPeer } = await import('../src/webrtcOrientationPeer.js');
  const { FakePeerConnection } = createPeerHarness();
  const session = createControllerOrientationPeer({
    RTCPeerConnectionClass: FakePeerConnection,
    socket: { emit() {} },
    roomId: 'ABCD',
    onChannel() {},
  });
  const candidates = Array.from({ length: 66 }, (_, index) => ({ candidate: `candidate-${index}` }));

  for (const candidate of candidates) {
    await session.addCandidate(candidate);
  }
  await session.acceptOffer({ type: 'offer', sdp: 'host-offer' });

  assert.equal(session.peer.addedCandidates.length, 64);
  assert.deepEqual(session.peer.addedCandidates, candidates.slice(0, 64));
});

test('controller peer caps total host ICE after the offer', async () => {
  const { createControllerOrientationPeer } = await import('../src/webrtcOrientationPeer.js');
  const { FakePeerConnection } = createPeerHarness();
  const session = createControllerOrientationPeer({
    RTCPeerConnectionClass: FakePeerConnection,
    socket: { emit() {} },
    roomId: 'ABCD',
    onChannel() {},
  });
  await session.acceptOffer({ type: 'offer', sdp: 'host-offer' });
  const candidates = Array.from({ length: 66 }, (_, index) => ({ candidate: `candidate-${index}` }));

  for (const candidate of candidates) await session.addCandidate(candidate);

  assert.equal(session.peer.addedCandidates.length, 64);
  assert.deepEqual(session.peer.addedCandidates, candidates.slice(0, 64));
});

test('controller peer shares one ICE cap across pre- and post-offer candidates', async () => {
  const { createControllerOrientationPeer } = await import('../src/webrtcOrientationPeer.js');
  const { FakePeerConnection } = createPeerHarness();
  const session = createControllerOrientationPeer({
    RTCPeerConnectionClass: FakePeerConnection,
    socket: { emit() {} },
    roomId: 'ABCD',
    onChannel() {},
  });
  const candidates = Array.from({ length: 66 }, (_, index) => ({ candidate: `candidate-${index}` }));
  for (const candidate of candidates.slice(0, 32)) await session.addCandidate(candidate);
  await session.acceptOffer({ type: 'offer', sdp: 'host-offer' });
  for (const candidate of candidates.slice(32)) await session.addCandidate(candidate);

  assert.equal(session.peer.addedCandidates.length, 64);
  assert.deepEqual(session.peer.addedCandidates, candidates.slice(0, 64));
});

test('controller peer stops offer negotiation when close wins queued ICE setup', async () => {
  const { createControllerOrientationPeer } = await import('../src/webrtcOrientationPeer.js');
  const { FakePeerConnection } = createPeerHarness();
  const candidateStarted = createDeferred();
  const candidateAdded = createDeferred();
  let createAnswerCalls = 0;

  class DelayedPeerConnection extends FakePeerConnection {
    async addIceCandidate(candidate) {
      candidateStarted.resolve();
      await candidateAdded.promise;
      return super.addIceCandidate(candidate);
    }

    async createAnswer() {
      createAnswerCalls += 1;
      return super.createAnswer();
    }
  }

  const socketEvents = [];
  const session = createControllerOrientationPeer({
    RTCPeerConnectionClass: DelayedPeerConnection,
    socket: { emit(event, payload) { socketEvents.push({ event, payload }); } },
    roomId: 'ABCD',
    onChannel() {},
  });
  await session.addCandidate({ candidate: 'queued-candidate' });

  const acceptingOffer = session.acceptOffer({ type: 'offer', sdp: 'host-offer' });
  await candidateStarted.promise;
  session.close();
  candidateAdded.resolve();
  await acceptingOffer;

  assert.equal(createAnswerCalls, 0);
  assert.deepEqual(socketEvents, []);
});

test('controller peer signals gathered ICE to its room host', async () => {
  const { createControllerOrientationPeer } = await import('../src/webrtcOrientationPeer.js');
  const { FakePeerConnection } = createPeerHarness();
  const socketEvents = [];
  const session = createControllerOrientationPeer({
    RTCPeerConnectionClass: FakePeerConnection,
    socket: { emit(event, payload) { socketEvents.push({ event, payload }); } },
    roomId: 'ABCD',
    onChannel() {},
  });
  const candidate = { candidate: 'controller-candidate', sdpMid: '0', sdpMLineIndex: 0 };

  session.peer.onicecandidate({ candidate });
  session.peer.onicecandidate({ candidate: null });

  assert.deepEqual(socketEvents, [{
    event: 'webrtc_controller_candidate',
    payload: { roomId: 'ABCD', candidate },
  }]);
});

test('controller peer close is idempotent and disconnects late callbacks', async () => {
  const { createControllerOrientationPeer } = await import('../src/webrtcOrientationPeer.js');
  const { FakePeerConnection } = createPeerHarness();
  const socketEvents = [];
  const channels = [];
  const session = createControllerOrientationPeer({
    RTCPeerConnectionClass: FakePeerConnection,
    socket: { emit(event, payload) { socketEvents.push({ event, payload }); } },
    roomId: 'ABCD',
    onChannel(channel) {
      channels.push(channel);
      channel.onmessage = () => {};
    },
  });
  const handleDataChannel = session.peer.ondatachannel;
  const handleIceCandidate = session.peer.onicecandidate;
  const channel = new FakeDataChannel('orientation', {});
  handleDataChannel({ channel });

  session.close();
  session.close();

  assert.equal(session.peer.ondatachannel, null);
  assert.equal(session.peer.onicecandidate, null);
  assert.equal(channel.onmessage, null);
  assert.equal(session.peer.closeCalls, 1);
  assert.equal(channel.closeCalls, 1);

  const lateChannel = new FakeDataChannel('orientation', {});
  handleDataChannel({ channel: lateChannel });
  handleIceCandidate({ candidate: { candidate: 'late-controller-candidate' } });
  assert.deepEqual(channels, [channel]);
  assert.equal(lateChannel.closeCalls, 1);
  assert.deepEqual(socketEvents, []);
});

test('Socket.IO orientation is accepted only while the direct channel is unavailable', async () => {
  const { shouldAcceptRelayedOrientation } = await import('../src/webrtcOrientationPeer.js');

  assert.equal(shouldAcceptRelayedOrientation(null), true);
  assert.equal(shouldAcceptRelayedOrientation({ channel: { readyState: 'connecting' } }), true);
  assert.equal(shouldAcceptRelayedOrientation({ channel: { readyState: 'open' } }), false);
  assert.equal(shouldAcceptRelayedOrientation({ channel: { readyState: 'closed' } }), true);
});

test('each controller Socket.IO reconnect recreates its peer before rejoining', async () => {
  const { bindControllerOrientationReconnect } = await import('../src/webrtcOrientationPeer.js');
  const listeners = new Map();
  const calls = [];
  const socket = {
    on(event, listener) { listeners.set(event, listener); },
    off(event, listener) {
      if (listeners.get(event) === listener) listeners.delete(event);
    },
    emit(event, payload) { calls.push({ type: 'emit', event, payload }); },
  };
  const unbind = bindControllerOrientationReconnect({
    socket,
    roomId: 'ABCD',
    recreatePeer() { calls.push({ type: 'recreate' }); },
  });

  listeners.get('connect')();
  listeners.get('connect')();

  assert.deepEqual(calls, [
    { type: 'recreate' },
    { type: 'emit', event: 'join_room', payload: { roomId: 'ABCD' } },
    { type: 'recreate' },
    { type: 'emit', event: 'join_room', payload: { roomId: 'ABCD' } },
  ]);
  unbind();
  assert.equal(listeners.has('connect'), false);
});

test('host resets room state when a recreated room receives the same code', async () => {
  const { shouldResetHostRoomState } = await import('../src/webrtcOrientationPeer.js');

  assert.equal(shouldResetHostRoomState(null), false);
  assert.equal(shouldResetHostRoomState('ABCD'), true);
});
