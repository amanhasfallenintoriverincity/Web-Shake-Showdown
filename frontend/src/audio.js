// Music uses an HTML audio element as the authoritative beatmap clock. The glass
// shatter stays in Web Audio so overlapping hits do not restart the track.

let audioCtx = null;
let masterGain = null;
let glassNoiseBuffer = null;
let started = false;
let music = null;
let musicUrl = null;
let musicEndedHandler = null;

const MUSIC_VOLUME = 0.68;

function ctx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.62;
    masterGain.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') void audioCtx.resume();
  return audioCtx;
}

function createGlassNoiseBuffer(context) {
  const duration = 0.32;
  const samples = Math.floor(context.sampleRate * duration);
  const buffer = context.createBuffer(1, samples, context.sampleRate);
  const data = buffer.getChannelData(0);

  // Irregular, rapidly decaying noise gives the initial brittle glass crack.
  for (let index = 0; index < samples; index += 1) {
    const progress = index / samples;
    const envelope = Math.pow(1 - progress, 2.4);
    const impulse = Math.random() > 0.82 ? 1.8 : 0.55;
    data[index] = (Math.random() * 2 - 1) * envelope * impulse;
  }
  return buffer;
}

function getGlassNoiseBuffer(context) {
  if (!glassNoiseBuffer) glassNoiseBuffer = createGlassNoiseBuffer(context);
  return glassNoiseBuffer;
}

function clearMusicEndedHandler() {
  if (!music || !musicEndedHandler) return;
  music.removeEventListener('ended', musicEndedHandler);
  musicEndedHandler = null;
}

function getMusic(songUrl) {
  if (!music || musicUrl !== songUrl) {
    if (music) {
      clearMusicEndedHandler();
      music.pause();
    }
    music = new window.Audio(songUrl);
    musicUrl = songUrl;
    music.preload = 'auto';
    music.volume = MUSIC_VOLUME;
  }
  return music;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
}

function getFragmentFrequencies(soundProfile) {
  const rootFrequency = Number.isFinite(soundProfile?.rootFrequency)
    ? clamp(soundProfile.rootFrequency, 36, 82)
    : null;
  if (!rootFrequency) return [1650, 2280, 3070, 3980, 5150, 6730];

  const scaleSteps = soundProfile.scale === 'major'
    ? [0, 4, 7, 11, 12, 16]
    : [0, 3, 7, 10, 12, 15];
  const brightness = clamp(soundProfile.brightness, 0, 1);
  const brightnessMultiplier = 0.82 + brightness * 0.45;
  return scaleSteps.map(semitones => (
    rootFrequency * 32 * (2 ** (semitones / 12)) * brightnessMultiplier
  ));
}

export function playHitSound(context, output = masterGain, soundProfile = {}) {
  const now = context.currentTime;
  const lowRatio = clamp(soundProfile.lowRatio ?? 0.5, 0, 1);
  const midRatio = clamp(soundProfile.midRatio ?? 0.4, 0, 1);
  const highRatio = clamp(soundProfile.highRatio ?? 0.1, 0, 1);
  const brightness = clamp(soundProfile.brightness ?? 0.2, 0, 1);
  const intensity = clamp(soundProfile.intensity ?? 0.7, 0, 1);
  const beatDuration = clamp(soundProfile.beatDuration ?? 0.5, 0.25, 1.5);
  const rootFrequency = Number.isFinite(soundProfile.rootFrequency)
    ? clamp(soundProfile.rootFrequency, 36, 82)
    : 46;
  const maximumKickDuration = clamp(beatDuration * 0.7, 0.18, 0.42);
  const kickDuration = Math.min(0.18 + lowRatio * 0.18, maximumKickDuration);

  // Bass-heavy beats ring longer and settle on the detected song key.
  const kick = context.createOscillator();
  kick.type = 'sine';
  kick.frequency.setValueAtTime(
    clamp(rootFrequency * (3.2 + brightness * 0.8), 110, 190),
    now
  );
  kick.frequency.exponentialRampToValueAtTime(
    rootFrequency,
    now + Math.min(0.16, kickDuration * 0.7)
  );
  const kickGain = context.createGain();
  kickGain.gain.setValueAtTime(clamp(0.42 + intensity * 0.26 + lowRatio * 0.2, 0.4, 0.9), now);
  kickGain.gain.exponentialRampToValueAtTime(0.001, now + kickDuration);
  kick.connect(kickGain).connect(output);
  kick.start(now);
  kick.stop(now + kickDuration + 0.02);

  // Bright/high-heavy beats produce a sharper, more prominent transient.
  const noise = context.createBufferSource();
  noise.buffer = getGlassNoiseBuffer(context);
  const noiseFilter = context.createBiquadFilter();
  noiseFilter.type = 'highpass';
  noiseFilter.frequency.value = clamp(1200 + brightness * 5000 + highRatio * 1800, 1200, 8200);
  noiseFilter.Q.value = 0.8;
  const noiseGain = context.createGain();
  const crackDuration = clamp(0.14 + midRatio * 0.1 + highRatio * 0.08, 0.14, 0.3);
  noiseGain.gain.setValueAtTime(
    clamp(0.2 + intensity * 0.2 + highRatio * 0.28, 0.2, 0.68),
    now
  );
  noiseGain.gain.exponentialRampToValueAtTime(0.001, now + crackDuration);
  noise.connect(noiseFilter).connect(noiseGain).connect(output);
  noise.start(now);
  noise.stop(now + crackDuration + 0.02);

  // Tonal fragments follow the detected key while spectral balance controls their color.
  const fragmentFrequencies = getFragmentFrequencies(soundProfile);
  fragmentFrequencies.forEach((baseFrequency, index) => {
    const fragment = context.createOscillator();
    fragment.type = index % 2 === 0 ? 'sine' : 'triangle';
    const frequency = baseFrequency;
    const duration = 0.1 + index * 0.028 + midRatio * 0.08;
    fragment.frequency.setValueAtTime(frequency, now);
    fragment.frequency.exponentialRampToValueAtTime(frequency * 0.82, now + duration);

    const fragmentGain = context.createGain();
    fragmentGain.gain.setValueAtTime(
      (0.09 + highRatio * 0.12 + midRatio * 0.04) * intensity / (1 + index * 0.14),
      now
    );
    fragmentGain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    fragment.connect(fragmentGain).connect(output);
    fragment.start(now + index * 0.004);
    fragment.stop(now + duration + 0.02);
  });
}

/** Unlock Web Audio on the host's Start Game click without starting music yet. */
export function initAudio() {
  if (started) return;
  started = true;
  const context = ctx();
  getGlassNoiseBuffer(context);
}

export async function startMusic(songUrl, onEnded) {
  initAudio();
  const track = getMusic(songUrl);
  track.pause();
  track.currentTime = 0;
  clearMusicEndedHandler();

  if (onEnded) {
    musicEndedHandler = onEnded;
    track.addEventListener('ended', musicEndedHandler, { once: true });
  }

  await track.play();
}

export function pauseMusic() {
  music?.pause();
}

export async function resumeMusic() {
  if (music?.paused) await music.play();
}

export function stopMusic() {
  if (!music) return;
  clearMusicEndedHandler();
  music.pause();
  music.currentTime = 0;
}

export function getMusicTime() {
  return music?.currentTime ?? 0;
}

/** Play the glass-shatter hit effect. Safe to call before explicit initialization. */
export function playHit(soundProfile) {
  if (!started) initAudio();
  playHitSound(ctx(), masterGain, soundProfile);
}
