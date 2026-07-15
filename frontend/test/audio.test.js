import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getMusicTime,
  initAudio,
  pauseMusic,
  playHitSound,
  resumeMusic,
  startMusic,
  stopMusic,
} from '../src/audio.js';

class AudioNode {
  connect(target) {
    return target;
  }
}

function createAudioHarness() {
  const oscillators = [];
  const bufferSources = [];
  const audioElements = [];
  const filters = [];

  class FakeAudioContext {
    constructor() {
      this.currentTime = 0;
      this.state = 'running';
      this.sampleRate = 48000;
      this.destination = new AudioNode();
    }

    createGain() {
      const gain = new AudioNode();
      gain.gain = {
        value: 0,
        setValueAtTime() {},
        linearRampToValueAtTime() {},
        exponentialRampToValueAtTime() {},
      };
      return gain;
    }

    createOscillator() {
      const oscillator = new AudioNode();
      const frequencyEvents = [];
      oscillator.frequency = {
        value: 0,
        setValueAtTime(value, time) {
          frequencyEvents.push({ type: 'set', value, time });
        },
        exponentialRampToValueAtTime(value, time) {
          frequencyEvents.push({ type: 'ramp', value, time });
        },
      };
      oscillator.frequencyEvents = frequencyEvents;
      oscillator.start = time => {
        oscillator.started = true;
        oscillator.startTime = time;
      };
      oscillator.stop = time => {
        oscillator.stopped = true;
        oscillator.stopTime = time;
      };
      oscillators.push(oscillator);
      return oscillator;
    }

    createBiquadFilter() {
      const filter = new AudioNode();
      filter.frequency = { value: 0 };
      filter.Q = { value: 0 };
      filters.push(filter);
      return filter;
    }

    createBuffer(_channels, sampleCount) {
      return { getChannelData: () => new Float32Array(sampleCount) };
    }

    createBufferSource() {
      const source = new AudioNode();
      source.start = () => { source.started = true; };
      source.stop = () => { source.stopped = true; };
      bufferSources.push(source);
      return source;
    }
  }

  class FakeAudio {
    constructor(source) {
      this.source = source;
      this.currentTime = 0;
      this.listeners = new Map();
      audioElements.push(this);
    }

    addEventListener(event, listener) {
      this.listeners.set(event, listener);
    }

    removeEventListener(event, listener) {
      if (this.listeners.get(event) === listener) this.listeners.delete(event);
    }

    pause() {
      this.paused = true;
    }

    play() {
      this.played = true;
      this.paused = false;
      return Promise.resolve();
    }
  }

  return {
    FakeAudioContext,
    FakeAudio,
    audioElements,
    oscillators,
    bufferSources,
    filters,
  };
}

test('a hit starts a noise crack and multiple ringing glass fragments', () => {
  const { FakeAudioContext, oscillators, bufferSources } = createAudioHarness();
  const context = new FakeAudioContext();

  playHitSound(context, context.destination);

  assert.equal(bufferSources.length, 1);
  assert.equal(bufferSources[0].started, true);
  assert.equal(bufferSources[0].stopped, true);
  assert.equal(oscillators.length >= 6, true);
  assert.equal(oscillators.every(oscillator => oscillator.started), true);
  assert.equal(oscillators.every(oscillator => oscillator.stopped), true);
});

test('a sword hit adds a short downward-pitched drum bass thump', () => {
  const { FakeAudioContext, oscillators } = createAudioHarness();
  const context = new FakeAudioContext();

  playHitSound(context, context.destination);

  const bassOscillator = oscillators.find(oscillator => {
    const start = oscillator.frequencyEvents.find(event => event.type === 'set');
    const end = oscillator.frequencyEvents.find(event => event.type === 'ramp');
    return start?.value <= 180 && end?.value <= 60;
  });

  assert.ok(bassOscillator, 'expected a low oscillator with a kick-drum pitch drop');
  assert.equal(bassOscillator.started, true);
  assert.equal(bassOscillator.stopped, true);
  assert.ok(bassOscillator.stopTime <= context.currentTime + 0.35);
});

test('analyzed sound profiles retune the bass and change its decay and crack brightness', () => {
  const bassHeavyHarness = createAudioHarness();
  const brightHarness = createAudioHarness();
  const bassContext = new bassHeavyHarness.FakeAudioContext();
  const brightContext = new brightHarness.FakeAudioContext();

  playHitSound(bassContext, bassContext.destination, {
    lowRatio: 0.8,
    midRatio: 0.18,
    highRatio: 0.02,
    brightness: 0.2,
    intensity: 1,
    rootFrequency: 51.91,
    scale: 'minor',
    beatDuration: 0.5,
  });
  playHitSound(brightContext, brightContext.destination, {
    lowRatio: 0.1,
    midRatio: 0.3,
    highRatio: 0.6,
    brightness: 0.9,
    intensity: 0.5,
    rootFrequency: 65.41,
    scale: 'major',
    beatDuration: 0.5,
  });

  const bassKick = bassHeavyHarness.oscillators[0];
  const brightKick = brightHarness.oscillators[0];
  const bassEndPitch = bassKick.frequencyEvents.find(event => event.type === 'ramp').value;
  const brightEndPitch = brightKick.frequencyEvents.find(event => event.type === 'ramp').value;

  assert.ok(Math.abs(bassEndPitch - 51.91) < 0.01);
  assert.ok(Math.abs(brightEndPitch - 65.41) < 0.01);
  assert.ok(bassKick.stopTime > brightKick.stopTime);
  assert.ok(brightHarness.filters[0].frequency.value > bassHeavyHarness.filters[0].frequency.value);
});

test('initializing audio does not start any background music', () => {
  const { FakeAudioContext, oscillators } = createAudioHarness();
  const originalWindow = globalThis.window;
  const originalSetInterval = globalThis.setInterval;

  globalThis.window = { AudioContext: FakeAudioContext };
  globalThis.setInterval = () => 1;

  try {
    initAudio();
    assert.equal(oscillators.length, 0);
  } finally {
    globalThis.window = originalWindow;
    globalThis.setInterval = originalSetInterval;
  }
});

test('the analyzed track starts at zero and exposes its playback position as the map clock', async () => {
  const { FakeAudioContext, FakeAudio, audioElements } = createAudioHarness();
  const originalWindow = globalThis.window;
  globalThis.window = { AudioContext: FakeAudioContext, Audio: FakeAudio };

  try {
    await startMusic('/audio/analyzed.mp3');

    assert.equal(audioElements.length, 1);
    assert.equal(audioElements[0].source, '/audio/analyzed.mp3');
    assert.equal(audioElements[0].played, true);
    assert.equal(audioElements[0].currentTime, 0);

    audioElements[0].currentTime = 12.5;
    assert.equal(getMusicTime(), 12.5);

    stopMusic();
    assert.equal(audioElements[0].paused, true);
    assert.equal(audioElements[0].currentTime, 0);
  } finally {
    globalThis.window = originalWindow;
  }
});

test('pausing for calibration preserves the music clock until playback resumes', async () => {
  const { FakeAudioContext, FakeAudio, audioElements } = createAudioHarness();
  const originalWindow = globalThis.window;
  globalThis.window = { AudioContext: FakeAudioContext, Audio: FakeAudio };

  try {
    await startMusic('/audio/calibration-pause.mp3');
    audioElements[0].currentTime = 7.25;

    pauseMusic();
    assert.equal(audioElements[0].paused, true);
    assert.equal(getMusicTime(), 7.25);

    await resumeMusic();
    assert.equal(audioElements[0].paused, false);
    assert.equal(getMusicTime(), 7.25);
    stopMusic();
  } finally {
    globalThis.window = originalWindow;
  }
});
