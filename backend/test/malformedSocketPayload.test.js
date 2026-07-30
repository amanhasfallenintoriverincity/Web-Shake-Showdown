const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { io } = require('socket.io-client');

const backendDirectory = path.resolve(__dirname, '..');
const destructuredSocketEvents = [
  'replace_room',
  'join_room',
  'calibration_started',
  'calibration_completed',
  'orientation',
  'webrtc_offer',
  'webrtc_answer',
  'webrtc_host_candidate',
  'webrtc_controller_candidate',
  'player_hit',
];
const malformedPayloads = [
  'not-an-object',
  42,
  true,
  { roomId: 42 },
  null,
];

function waitForSocketEvent(socket, eventName, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(eventName, onEvent);
      reject(new Error(`timed out waiting for Socket.IO event: ${eventName}`));
    }, timeoutMs);
    const onEvent = (...args) => {
      clearTimeout(timeout);
      resolve(args);
    };
    socket.once(eventName, onEvent);
  });
}

function waitUntilReady(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('backend startup timed out'));
    }, 5000);
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
    };
    const onData = (chunk) => {
      const match = chunk.toString().match(/Server listening on 0\.0\.0\.0:(\d+)/);
      if (!match || Number(match[1]) === 0) return;
      cleanup();
      resolve(Number(match[1]));
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`backend exited before startup with code ${code}, signal ${signal}`));
    };

    child.stdout.on('data', onData);
    child.once('exit', onExit);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

async function startBackend(t) {
  let stderr = '';
  const child = spawn(process.execPath, ['index.js'], {
    cwd: backendDirectory,
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  t.after(() => stopChild(child));

  const port = await waitUntilReady(child);
  return { child, exited, getStderr: () => stderr, port };
}

test('malformed payloads for destructured Socket.IO events do not terminate the backend', async (t) => {
  for (const eventName of destructuredSocketEvents) {
    await t.test(eventName, async (t) => {
      const backend = await startBackend(t);
      const socket = io(`http://127.0.0.1:${backend.port}`, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
      });
      t.after(() => socket.close());
      await waitForSocketEvent(socket, 'connect');

      const roomCreated = waitForSocketEvent(socket, 'room_created').then(([roomId]) => roomId);
      for (const payload of malformedPayloads) {
        socket.emit(eventName, payload);
      }
      socket.emit('create_room');

      const roomId = await Promise.race([
        roomCreated,
        backend.exited.then(({ code, signal }) => {
          throw new Error(
            `backend terminated after malformed ${eventName} payload: code ${code}, signal ${signal}\n${backend.getStderr()}`
          );
        }),
      ]);

      assert.match(roomId, /^[A-Z0-9]{4}$/);
      assert.equal(backend.child.exitCode, null);
    });
  }
});
