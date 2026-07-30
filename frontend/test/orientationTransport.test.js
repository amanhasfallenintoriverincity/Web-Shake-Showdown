import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrientationPublisher } from '../src/orientationTransport.js';

function createFakeClock() {
  let time = 0;
  let nextTimerId = 1;
  const timers = new Map();

  const advanceTo = targetTime => {
    while (timers.size > 0) {
      let dueTimerId = null;
      let dueTime = Infinity;

      for (const [timerId, timer] of timers) {
        if (timer.runAt < dueTime) {
          dueTimerId = timerId;
          dueTime = timer.runAt;
        }
      }

      if (dueTime > targetTime) break;
      time = dueTime;
      const { callback } = timers.get(dueTimerId);
      timers.delete(dueTimerId);
      callback();
    }

    time = targetTime;
  };

  return {
    now: () => time,
    setTimer(callback, delay) {
      const timerId = nextTimerId;
      nextTimerId += 1;
      timers.set(timerId, { callback, runAt: time + delay });
      return timerId;
    },
    clearTimer(timerId) {
      timers.delete(timerId);
    },
    advanceTo,
  };
}

test('orientation publisher coalesces a 240Hz swing into latest-value 60Hz frames', () => {
  const events = [];
  const clock = createFakeClock();
  const socket = {
    connected: true,
    volatile: {
      emit(event, payload) { events.push({ event, payload }); },
    },
  };
  const publish = createOrientationPublisher({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  for (let alpha = 0; alpha < 240; alpha += 1) {
    clock.advanceTo(alpha * (1000 / 240));
    publish(socket, 'ABCD', { alpha });
  }
  clock.advanceTo(1000);

  assert.equal(events.length, 61);
  assert.deepEqual(events.at(-1), {
    event: 'orientation',
    payload: { roomId: 'ABCD', data: { alpha: 239 }, sequence: 60 },
  });
});

test('orientation publisher keeps a 16ms sensor cadence near 60Hz instead of aliasing to 30Hz', () => {
  const events = [];
  const clock = createFakeClock();
  const socket = {
    connected: true,
    volatile: {
      emit(event, payload) { events.push({ event, payload }); },
    },
  };
  const publish = createOrientationPublisher({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  for (let alpha = 0; alpha < 60; alpha += 1) {
    clock.advanceTo(alpha * 16);
    publish(socket, 'ABCD', { alpha });
  }
  clock.advanceTo(1000);

  assert.equal(events.length, 58);
  assert.equal(events.at(-1).payload.data.alpha, 59);
});

test('an open WebRTC channel bypasses Socket.IO with a compact orientation packet', () => {
  const socketEvents = [];
  const channelPackets = [];
  const socket = {
    connected: true,
    volatile: {
      emit(event, payload) { socketEvents.push({ event, payload }); },
    },
  };
  const dataChannel = {
    readyState: 'open',
    bufferedAmount: 0,
    send(packet) { channelPackets.push(packet); },
  };
  const publish = createOrientationPublisher();

  publish(socket, 'ABCD', { alpha: 12.5, beta: 91.25, gamma: -4.5 }, dataChannel);

  assert.equal(socketEvents.length, 0);
  assert.equal(channelPackets.length, 1);
  assert.equal(channelPackets[0].byteLength, 16);
  const packet = new DataView(channelPackets[0]);
  assert.equal(packet.getUint32(0, true), 0);
  assert.equal(packet.getFloat32(4, true), 12.5);
  assert.equal(packet.getFloat32(8, true), 91.25);
  assert.equal(packet.getFloat32(12, true), -4.5);
});

test('a WebRTC send-close race drops the pose without a duplicate relay', () => {
  const socketEvents = [];
  const data = { alpha: 12.5, beta: 91.25, gamma: -4.5 };
  const socket = {
    connected: true,
    volatile: {
      emit(event, payload) { socketEvents.push({ event, payload }); },
    },
  };
  const dataChannel = {
    readyState: 'open',
    bufferedAmount: 0,
    send() { throw new Error('channel closed during send'); },
  };
  const publish = createOrientationPublisher();
  let published;

  assert.doesNotThrow(() => {
    published = publish(socket, 'ABCD', data, dataChannel);
  });
  assert.equal(published, false);
  assert.deepEqual(socketEvents, []);
});

test('Socket.IO fallback and WebRTC direct packets share one sequence', () => {
  const clock = createFakeClock();
  const socketEvents = [];
  const channelPackets = [];
  const socket = {
    connected: true,
    volatile: {
      emit(event, payload) { socketEvents.push({ event, payload }); },
    },
  };
  const dataChannel = {
    readyState: 'open',
    bufferedAmount: 0,
    send(packet) { channelPackets.push(packet); },
  };
  const publish = createOrientationPublisher({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  publish(socket, 'ABCD', { alpha: 10, beta: 80, gamma: -2 });
  clock.advanceTo(17);
  publish(socket, 'ABCD', { alpha: 20, beta: 90, gamma: 3 }, dataChannel);

  assert.equal(socketEvents[0].payload.sequence, 0);
  assert.equal(new DataView(channelPackets[0]).getUint32(0, true), 1);
});

test('a backpressured WebRTC channel drops a pose instead of queueing or relaying it', () => {
  const socketEvents = [];
  const channelPackets = [];
  const socket = {
    connected: true,
    volatile: {
      emit(event, payload) { socketEvents.push({ event, payload }); },
    },
  };
  const dataChannel = {
    readyState: 'open',
    bufferedAmount: 16,
    send(packet) { channelPackets.push(packet); },
  };
  const publish = createOrientationPublisher();

  publish(socket, 'ABCD', { alpha: 90, beta: 90, gamma: 0 }, dataChannel);

  assert.equal(channelPackets.length, 0);
  assert.equal(socketEvents.length, 0);
});

test('unordered WebRTC packets cannot rewind the sword pose', async () => {
  const { createOrientationPacketReceiver } = await import('../src/orientationTransport.js');
  const clock = createFakeClock();
  const channelPackets = [];
  const dataChannel = {
    readyState: 'open',
    bufferedAmount: 0,
    send(packet) { channelPackets.push(packet); },
  };
  const publish = createOrientationPublisher({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  publish(null, 'ABCD', { alpha: 10, beta: 80, gamma: -2 }, dataChannel);
  clock.advanceTo(17);
  publish(null, 'ABCD', { alpha: 20, beta: 90, gamma: 3 }, dataChannel);

  const received = [];
  const receive = createOrientationPacketReceiver(data => received.push(data));

  assert.equal(receive(channelPackets[1]), true);
  assert.equal(receive(channelPackets[0]), false);
  assert.deepEqual(received, [{ alpha: 20, beta: 90, gamma: 3 }]);
});

test('tracked orientation rejects malformed and stale cross-transport updates', async () => {
  const { applyTrackedOrientation, initializeTrackedOrientation } = await import('../src/orientationTransport.js');
  const orientations = {
    'player-1': { alpha: 0, beta: 90, gamma: 0 },
  };
  const sequences = {};
  const newest = { alpha: 20, beta: 90, gamma: 3 };

  assert.equal(applyTrackedOrientation(orientations, sequences, 'player-1', null, 0), false);
  assert.equal(applyTrackedOrientation(
    orientations,
    sequences,
    'player-1',
    { alpha: 10, beta: 'invalid', gamma: -2 },
    1
  ), false);
  assert.equal(applyTrackedOrientation(orientations, sequences, 'player-1', newest, 2), true);
  assert.equal(applyTrackedOrientation(
    orientations,
    sequences,
    'player-1',
    { alpha: 10, beta: 80, gamma: -2 },
    1
  ), false);
  assert.deepEqual(orientations['player-1'], newest);

  const later = { alpha: 30, beta: 100, gamma: 4 };
  assert.equal(applyTrackedOrientation(orientations, sequences, 'player-1', later, 3), true);
  assert.deepEqual(orientations['player-1'], later);

  assert.equal(initializeTrackedOrientation(
    orientations,
    sequences,
    'player-1',
    { alpha: 0, beta: 90, gamma: 0 }
  ), false);
  assert.deepEqual(orientations['player-1'], later);
  assert.equal(sequences['player-1'], 3);

  sequences['player-1'] = 0xffffffff;
  const wrapped = { alpha: 40, beta: 110, gamma: 5 };
  assert.equal(applyTrackedOrientation(orientations, sequences, 'player-1', wrapped, 0), true);
  assert.deepEqual(orientations['player-1'], wrapped);
  assert.equal(applyTrackedOrientation(orientations, sequences, 'player-1', later, 0xffffffff), false);

  assert.equal(initializeTrackedOrientation(
    orientations,
    sequences,
    'player-2',
    { alpha: 0, beta: 90, gamma: 0 }
  ), true);
  assert.deepEqual(orientations['player-2'], { alpha: 0, beta: 90, gamma: 0 });
  assert.equal(sequences['player-2'], undefined);
});

test('reset cancels a pending pose without rewinding the shared sequence', () => {
  const clock = createFakeClock();
  const events = [];
  const socket = {
    connected: true,
    volatile: {
      emit(event, payload) { events.push({ event, payload }); },
    },
  };
  const publish = createOrientationPublisher({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  publish(socket, 'OLD', { alpha: 0, beta: 90, gamma: 0 });
  clock.advanceTo(4);
  publish(socket, 'OLD', { alpha: 45, beta: 90, gamma: 0 });
  publish.reset();
  clock.advanceTo(20);
  publish(socket, 'NEW', { alpha: 90, beta: 90, gamma: 0 });

  assert.equal(events.length, 2);
  assert.equal(events[0].payload.roomId, 'OLD');
  assert.equal(events[0].payload.data.alpha, 0);
  assert.equal(events[0].payload.sequence, 0);
  assert.equal(events[1].payload.roomId, 'NEW');
  assert.equal(events[1].payload.data.alpha, 90);
  assert.equal(events[1].payload.sequence, 1);
});

test('device orientation listener session stops sensor processing idempotently', async () => {
  const { createDeviceOrientationListener } = await import('../src/orientationTransport.js');
  const listeners = new Set();
  const target = {
    addEventListener(event, listener) {
      assert.equal(event, 'deviceorientation');
      listeners.add(listener);
    },
    removeEventListener(event, listener) {
      assert.equal(event, 'deviceorientation');
      listeners.delete(listener);
    },
  };
  const handler = () => {};
  const session = createDeviceOrientationListener(target, handler);

  session.start();
  session.start();
  assert.deepEqual([...listeners], [handler]);

  session.stop();
  session.stop();
  assert.equal(listeners.size, 0);

  session.start();
  assert.deepEqual([...listeners], [handler]);
  session.stop();
});

test('device orientation permission flow rejects an empty room before requesting access', async () => {
  const { createDeviceOrientationPermissionFlow } = await import('../src/orientationTransport.js');
  const flow = createDeviceOrientationPermissionFlow();
  let requests = 0;
  let invalidRooms = 0;

  const granted = await flow.start({
    roomId: '   ',
    requestPermission: async () => {
      requests += 1;
      return 'granted';
    },
    onInvalidRoom() { invalidRooms += 1; },
    onGranted() { throw new Error('invalid room must not start sensors'); },
  });

  assert.equal(granted, false);
  assert.equal(requests, 0);
  assert.equal(invalidRooms, 1);
});

test('device orientation permission flow ignores a grant after invalidation', async () => {
  const { createDeviceOrientationPermissionFlow } = await import('../src/orientationTransport.js');
  const flow = createDeviceOrientationPermissionFlow();
  let resolvePermission;
  let grants = 0;
  const permission = new Promise(resolve => { resolvePermission = resolve; });

  const pending = flow.start({
    roomId: 'ABCD',
    requestPermission: () => permission,
    onGranted() { grants += 1; },
  });
  flow.invalidate();
  resolvePermission('granted');

  assert.equal(await pending, false);
  assert.equal(grants, 0);
});

test('device orientation permission flow lets only the newest attempt connect', async () => {
  const { createDeviceOrientationPermissionFlow } = await import('../src/orientationTransport.js');
  const flow = createDeviceOrientationPermissionFlow();
  let resolveFirst;
  let resolveSecond;
  const firstPermission = new Promise(resolve => { resolveFirst = resolve; });
  const secondPermission = new Promise(resolve => { resolveSecond = resolve; });
  const grants = [];

  const first = flow.start({
    roomId: 'ABCD',
    requestPermission: () => firstPermission,
    onGranted() { grants.push('first'); },
  });
  const second = flow.start({
    roomId: 'EFGH',
    requestPermission: () => secondPermission,
    onGranted() { grants.push('second'); },
  });
  resolveFirst('granted');
  resolveSecond('granted');

  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.deepEqual(grants, ['second']);
});
