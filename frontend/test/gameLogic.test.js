import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GAME_RESULT_DURATION_MS,
  getGameStateAfterMiss,
  getSwordEuler,
  incrementScore,
  swordHitsObstacle,
} from '../src/gameLogic.js';

test('a visible obstacle touching the neutral sword blade is hit', () => {
  const hit = swordHitsObstacle({
    swordX: 0,
    orientation: { alpha: 0, beta: 0, gamma: 0 },
    obstacle: { x: 0, y: 0, z: -4 },
  });

  assert.equal(hit, true);
});

test('a fast obstacle crossing the blade between frames is hit', () => {
  const hit = swordHitsObstacle({
    swordX: 0,
    orientation: { alpha: 90, beta: 0, gamma: 0 },
    obstacle: { x: -3, y: 0, previousZ: -2, z: 2 },
  });

  assert.equal(hit, true);
});

test('incrementing a score does not mutate game player state', () => {
  const scores = { player1: 10 };
  const next = incrementScore(scores, 'player1');

  assert.deepEqual(next, { player1: 20 });
  assert.deepEqual(scores, { player1: 10 });
});

test('missing notes never ends the game', () => {
  assert.equal(getGameStateAfterMiss(), 'playing');
});

test('song completion keeps the five-second result screen', () => {
  assert.equal(GAME_RESULT_DURATION_MS, 5_000);
});

test('the complete sword uses one shared device-orientation pose', () => {
  const rotation = getSwordEuler({ alpha: 90, beta: 45, gamma: -30 });

  assert.equal(rotation.order, 'YXZ');
  assert.ok(Math.abs(rotation.x - Math.PI / 4) < 1e-9);
  assert.ok(Math.abs(rotation.y - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(rotation.z - Math.PI / 6) < 1e-9);
});
