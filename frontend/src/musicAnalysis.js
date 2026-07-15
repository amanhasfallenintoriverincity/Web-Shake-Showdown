import { isPlayableBeatmap } from './musicAnalysisCore.js';

const CACHE_PREFIX = 'web-shake-showdown:essentia-analysis:v3';

function createAbortError() {
  const error = new Error('음악 분석이 취소되었습니다.');
  error.name = 'AbortError';
  return error;
}

export function readCachedBeatmap(storage, key, songUrl) {
  try {
    const cached = JSON.parse(storage?.getItem(key) ?? 'null');
    return cached?.songUrl === songUrl && isPlayableBeatmap(cached) ? cached : null;
  } catch {
    return null;
  }
}

function writeCachedBeatmap(storage, key, beatmap) {
  try {
    storage?.setItem(key, JSON.stringify(beatmap));
  } catch {
    // Analysis remains usable when storage is unavailable or full.
  }
}

export function downmixAudioBuffer(audioBuffer) {
  const mono = new Float32Array(audioBuffer.length);
  const channelCount = Math.max(1, audioBuffer.numberOfChannels);

  for (let channel = 0; channel < channelCount; channel += 1) {
    const samples = audioBuffer.getChannelData(channel);
    for (let index = 0; index < mono.length; index += 1) {
      mono[index] += samples[index] / channelCount;
    }
  }

  return mono;
}

export async function loadAudioBytes({
  audioFile,
  songUrl,
  signal,
  fetchImpl = globalThis.fetch,
}) {
  if (audioFile) return audioFile.arrayBuffer();

  const response = await fetchImpl(songUrl, { signal });
  if (!response.ok) throw new Error(`음악 파일을 불러오지 못했습니다 (${response.status}).`);
  return response.arrayBuffer();
}

function runAnalysisWorker(payload, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const worker = new Worker(new URL('./musicAnalysis.worker.js', import.meta.url), { type: 'module' });
    const cleanup = () => {
      signal?.removeEventListener('abort', handleAbort);
      worker.terminate();
    };
    const fail = error => {
      cleanup();
      reject(error);
    };
    const handleAbort = () => fail(createAbortError());

    signal?.addEventListener('abort', handleAbort, { once: true });
    worker.onmessage = ({ data }) => {
      if (data.type === 'result') {
        cleanup();
        resolve(data.beatmap);
        return;
      }
      fail(new Error(data.message || 'Essentia.js 음악 분석에 실패했습니다.'));
    };
    worker.onerror = event => {
      event.preventDefault?.();
      fail(new Error(event.message || 'Essentia.js 분석 워커를 실행하지 못했습니다.'));
    };
    worker.postMessage(payload, [payload.samples]);
  });
}

export async function analyzeMusicTrack({
  songUrl,
  audioFile,
  title,
  artist,
  signal,
  onStatus,
  storage = globalThis.localStorage,
}) {
  const cacheKey = `${CACHE_PREFIX}:${songUrl}`;
  const cached = readCachedBeatmap(storage, cacheKey, songUrl);
  if (cached) {
    onStatus?.('cached');
    return cached;
  }

  if (signal?.aborted) throw createAbortError();
  onStatus?.('decoding');
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextClass) throw new Error('이 브라우저는 Web Audio API를 지원하지 않습니다.');

  const audioContext = new AudioContextClass();
  let audioBuffer;
  try {
    const audioBytes = await loadAudioBytes({ audioFile, songUrl, signal });
    audioBuffer = await audioContext.decodeAudioData(audioBytes);
  } finally {
    if (audioContext.close) await audioContext.close().catch(() => {});
  }

  const samples = downmixAudioBuffer(audioBuffer);
  onStatus?.('analyzing');
  const analyzed = await runAnalysisWorker({
    samples: samples.buffer,
    sampleRate: audioBuffer.sampleRate,
    duration: audioBuffer.duration,
  }, signal);
  const beatmap = {
    ...analyzed,
    songUrl,
    title,
    artist,
    analysisSource: 'Essentia.js',
  };
  if (!isPlayableBeatmap(beatmap)) {
    throw new Error('Essentia.js 분석 결과가 올바르지 않습니다.');
  }

  writeCachedBeatmap(storage, cacheKey, beatmap);
  onStatus?.('complete');
  return beatmap;
}
