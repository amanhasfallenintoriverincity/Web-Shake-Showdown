import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrientationPublisher } from '../src/orientationTransport.js';

test('orientation publisher forwards all 60 fresh samples from a fast one-second swing', () => {
  const events = [];
  const socket = {
    connected: true,
    volatile: {
      emit(event, payload) { events.push({ event, payload }); },
    },
  };
  const publish = createOrientationPublisher();

  for (let alpha = 0; alpha < 60; alpha += 1) {
    publish(socket, 'ABCD', { alpha });
  }

  assert.equal(events.length, 60);
  assert.deepEqual(events.at(-1), {
    event: 'orientation',
    payload: { roomId: 'ABCD', data: { alpha: 59 } },
  });
});
