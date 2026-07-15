import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_START_DELAY_MS,
  getAutoStartSecondsLeft,
  isAutoStartEligible,
  scheduleAutoStart,
} from '../src/autoStart.js';

test('auto-start becomes eligible only when at least one player and the music are ready', () => {
  const ready = {
    gameState: 'waiting',
    totalPlayers: 1,
    allPlayersReady: true,
    analysisReady: true,
    blocked: false,
  };

  assert.equal(isAutoStartEligible(ready), true);
  assert.equal(isAutoStartEligible({ ...ready, totalPlayers: 0 }), false);
  assert.equal(isAutoStartEligible({ ...ready, allPlayersReady: false }), false);
  assert.equal(isAutoStartEligible({ ...ready, analysisReady: false }), false);
  assert.equal(isAutoStartEligible({ ...ready, gameState: 'playing' }), false);
  assert.equal(isAutoStartEligible({ ...ready, blocked: true }), false);
});

test('the automatic start countdown lasts exactly five seconds and stops at zero', () => {
  assert.equal(AUTO_START_DELAY_MS, 5_000);
  assert.equal(getAutoStartSecondsLeft(0), 5);
  assert.equal(getAutoStartSecondsLeft(1_001), 4);
  assert.equal(getAutoStartSecondsLeft(4_999), 1);
  assert.equal(getAutoStartSecondsLeft(5_000), 0);
  assert.equal(getAutoStartSecondsLeft(9_000), 0);
});

test('the scheduler starts once after five seconds and can release both timers', () => {
  let currentTime = 1_000;
  let intervalTask;
  let timeoutTask;
  const cleared = [];
  const ticks = [];
  let starts = 0;

  const cancel = scheduleAutoStart({
    now: () => currentTime,
    onTick: seconds => ticks.push(seconds),
    onStart: () => { starts += 1; },
    setIntervalFn(callback, delay) {
      intervalTask = { callback, delay, id: 'interval' };
      return intervalTask.id;
    },
    setTimeoutFn(callback, delay) {
      timeoutTask = { callback, delay, id: 'timeout' };
      return timeoutTask.id;
    },
    clearIntervalFn: id => cleared.push(id),
    clearTimeoutFn: id => cleared.push(id),
  });

  assert.deepEqual(ticks, [5]);
  assert.equal(intervalTask.delay, 250);
  assert.equal(timeoutTask.delay, 5_000);

  currentTime = 4_001;
  intervalTask.callback();
  assert.equal(ticks.at(-1), 2);

  timeoutTask.callback();
  assert.equal(ticks.at(-1), 0);
  assert.equal(starts, 1);

  cancel();
  assert.deepEqual(cleared, ['interval', 'timeout']);
});
