import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import test from 'node:test';

const defaultBeatmapModule = await import('../src/defaultBeatmap.js').catch(() => ({}));
const hostView = readFileSync(new URL('../src/views/HostView.jsx', import.meta.url), 'utf8');

test('Dancing in My Room is the bundled default track', () => {
  const { DEFAULT_BEATMAP } = defaultBeatmapModule;

  assert.equal(typeof DEFAULT_BEATMAP, 'object');
  assert.equal(DEFAULT_BEATMAP.songUrl, '/audio/Dancing in My Room.mp3');
  assert.equal(DEFAULT_BEATMAP.title, 'Dancing in My Room');
  assert.equal(DEFAULT_BEATMAP.artist, '347aidan');
  assert.equal(DEFAULT_BEATMAP.duration, 180.163628);
  assert.equal(DEFAULT_BEATMAP.bpm, 120);

  const audioFile = new URL('../public/audio/Dancing in My Room.mp3', import.meta.url);
  assert.ok(statSync(audioFile).size > 0);
});

test('the host uses the Dancing in My Room beatmap for initial and restored music', () => {
  assert.match(hostView, /import \{ DEFAULT_BEATMAP \} from '\.\.\/defaultBeatmap';/);
  assert.doesNotMatch(hostView, /TOXIC_FALLBACK_BEATMAP/);
  assert.ok((hostView.match(/DEFAULT_BEATMAP/g) ?? []).length >= 8);
});
