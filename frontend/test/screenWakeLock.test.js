import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceOrientationPermissionFlow } from '../src/orientationTransport.js';
import { createScreenWakeLock } from '../src/screenWakeLock.js';

function createFakes() {
  const listeners = new Map();
  let requests = 0;
  let releases = 0;
  let releaseHandler = null;

  const documentObject = {
    visibilityState: 'visible',
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type) { listeners.delete(type); },
  };
  const navigatorObject = {
    wakeLock: {
      async request(type) {
        assert.equal(type, 'screen');
        requests += 1;
        return {
          addEventListener(type, handler) {
            if (type === 'release') releaseHandler = handler;
          },
          async release() { releases += 1; },
        };
      },
    },
  };

  return {
    documentObject,
    navigatorObject,
    listeners,
    simulateSystemRelease() { releaseHandler?.(); },
    counts: () => ({ requests, releases }),
  };
}

function createDeferredFakes() {
  const listeners = new Map();
  const pendingResolvers = [];
  let requests = 0;
  let releases = 0;

  const documentObject = {
    visibilityState: 'visible',
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type) { listeners.delete(type); },
  };
  const navigatorObject = {
    wakeLock: {
      request(type) {
        assert.equal(type, 'screen');
        requests += 1;
        return new Promise(resolve => {
          pendingResolvers.push(() => resolve({
            addEventListener() {},
            async release() { releases += 1; },
          }));
        });
      },
    },
  };

  return {
    documentObject,
    navigatorObject,
    resolveAll() {
      for (const resolve of pendingResolvers.splice(0)) resolve();
    },
    counts: () => ({ requests, releases }),
  };
}

test('screen wake lock stays active while the controller is active', async () => {
  const fakes = createFakes();
  const wakeLock = createScreenWakeLock(fakes);

  await wakeLock.start();
  assert.deepEqual(fakes.counts(), { requests: 1, releases: 0 });

  await wakeLock.stop();
  assert.deepEqual(fakes.counts(), { requests: 1, releases: 1 });
});

test('screen wake lock is reacquired after returning to the controller', async () => {
  const fakes = createFakes();
  const wakeLock = createScreenWakeLock(fakes);

  await wakeLock.start();
  fakes.simulateSystemRelease();
  fakes.documentObject.visibilityState = 'visible';
  fakes.listeners.get('visibilitychange')();
  await Promise.resolve();

  assert.deepEqual(fakes.counts(), { requests: 2, releases: 0 });
  await wakeLock.stop();
});

test('screen wake lock releases an acquisition that resolves after stop', async () => {
  const fakes = createDeferredFakes();
  const wakeLock = createScreenWakeLock(fakes);

  const starting = wakeLock.start();
  const stopping = wakeLock.stop();
  fakes.resolveAll();
  await Promise.all([starting, stopping]);

  assert.deepEqual(fakes.counts(), { requests: 1, releases: 1 });
});

test('screen wake lock deduplicates concurrent acquisition requests', async () => {
  const fakes = createDeferredFakes();
  const wakeLock = createScreenWakeLock(fakes);

  const first = wakeLock.start();
  const second = wakeLock.start();
  fakes.resolveAll();
  await Promise.all([first, second]);
  await wakeLock.stop();

  assert.deepEqual(fakes.counts(), { requests: 1, releases: 1 });
});

test('permission denial releases a wake lock that is still being acquired', async () => {
  const fakes = createDeferredFakes();
  const wakeLock = createScreenWakeLock(fakes);
  const flow = createDeviceOrientationPermissionFlow();
  let resolvePermission;
  let startingWakeLock;
  let stoppingWakeLock;
  const permission = new Promise(resolve => { resolvePermission = resolve; });

  const attempt = flow.start({
    roomId: 'ABCD',
    requestPermission() {
      startingWakeLock = wakeLock.start();
      return permission;
    },
    onDenied() { stoppingWakeLock = wakeLock.stop(); },
  });
  resolvePermission('denied');
  assert.equal(await attempt, false);
  fakes.resolveAll();
  await Promise.all([startingWakeLock, stoppingWakeLock]);

  assert.deepEqual(fakes.counts(), { requests: 1, releases: 1 });
});

test('invalid-room supersession releases the older pending wake lock', async () => {
  const fakes = createDeferredFakes();
  const wakeLock = createScreenWakeLock(fakes);
  const flow = createDeviceOrientationPermissionFlow();
  let resolvePermission;
  let startingWakeLock;
  let stoppingWakeLock;
  let grants = 0;
  const permission = new Promise(resolve => { resolvePermission = resolve; });

  const first = flow.start({
    roomId: 'ABCD',
    requestPermission() {
      startingWakeLock = wakeLock.start();
      return permission;
    },
    onGranted() { grants += 1; },
  });
  await flow.start({
    roomId: ' ',
    requestPermission() { throw new Error('invalid room must not request permission'); },
    onInvalidRoom() { stoppingWakeLock = wakeLock.stop(); },
  });
  resolvePermission('granted');
  assert.equal(await first, false);
  fakes.resolveAll();
  await Promise.all([startingWakeLock, stoppingWakeLock]);

  assert.equal(grants, 0);
  assert.deepEqual(fakes.counts(), { requests: 1, releases: 1 });
});

test('unmount invalidation releases a pending wake lock without reviving sensors', async () => {
  const fakes = createDeferredFakes();
  const wakeLock = createScreenWakeLock(fakes);
  const flow = createDeviceOrientationPermissionFlow();
  let resolvePermission;
  let startingWakeLock;
  let grants = 0;
  const permission = new Promise(resolve => { resolvePermission = resolve; });

  const attempt = flow.start({
    roomId: 'ABCD',
    requestPermission() {
      startingWakeLock = wakeLock.start();
      return permission;
    },
    onGranted() { grants += 1; },
  });
  flow.invalidate();
  const stoppingWakeLock = wakeLock.stop();
  resolvePermission('granted');
  assert.equal(await attempt, false);
  fakes.resolveAll();
  await Promise.all([startingWakeLock, stoppingWakeLock]);

  assert.equal(grants, 0);
  assert.deepEqual(fakes.counts(), { requests: 1, releases: 1 });
});
