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
    payload: { roomId: 'ABCD', data: { alpha: 239 } },
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
