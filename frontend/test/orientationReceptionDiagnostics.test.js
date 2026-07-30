import test from 'node:test';
import assert from 'node:assert/strict';

test('orientation reception diagnostics ignore a stale packet from the other path', async () => {
  const {
    applyTrackedOrientationReception,
    getOrientationReceptionDiagnostic,
  } = await import('../src/orientationTransport.js');
  const orientations = { 'player-1': { alpha: 0, beta: 0, gamma: 0 } };
  const sequences = {};
  const receptions = {};

  assert.equal(applyTrackedOrientationReception({
    orientations,
    sequences,
    receptions,
    playerId: 'player-1',
    data: { alpha: 10, beta: 20, gamma: 30 },
    sequence: 2,
    transport: 'DIRECT',
    receivedAt: 1000,
  }), true);
  assert.equal(applyTrackedOrientationReception({
    orientations,
    sequences,
    receptions,
    playerId: 'player-1',
    data: { alpha: 40, beta: 50, gamma: 60 },
    sequence: 1,
    transport: 'FALLBACK',
    receivedAt: 2000,
  }), false);

  assert.deepEqual(orientations['player-1'], { alpha: 10, beta: 20, gamma: 30 });
  assert.equal(getOrientationReceptionDiagnostic(receptions, 'player-1', 2100).transport, 'DIRECT');
  assert.equal(getOrientationReceptionDiagnostic(receptions, 'player-1', 2100).lastReceivedAt, 1000);
});
