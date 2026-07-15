import Essentia from 'essentia.js/dist/essentia.js-core.es.js';
import { EssentiaWASM } from 'essentia.js/dist/essentia-wasm.es.js';
import {
  buildBeatmapFromAnalysis,
  calculateBeatEnergies,
  extractRhythmWithEssentia,
  extractSoundProfilesWithEssentia,
  isPlayableBeatmap,
} from './musicAnalysisCore.js';

function waitForWasmRuntime() {
  if (EssentiaWASM.EssentiaJS) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Essentia WebAssembly 초기화 시간이 초과되었습니다.')), 30000);
    const previousHandler = EssentiaWASM.onRuntimeInitialized;
    EssentiaWASM.onRuntimeInitialized = () => {
      clearTimeout(timeout);
      previousHandler?.();
      resolve();
    };
  });
}

self.onmessage = async ({ data }) => {
  let essentia;

  try {
    await waitForWasmRuntime();
    const samples = new Float32Array(data.samples);
    essentia = new Essentia(EssentiaWASM);
    const rhythm = extractRhythmWithEssentia(essentia, samples, data.sampleRate);
    if (rhythm.beats.length < 4 || rhythm.bpm <= 0) {
      throw new Error('음악에서 안정적인 박자를 찾지 못했습니다.');
    }

    const energy = calculateBeatEnergies(samples, data.sampleRate, rhythm.beats);
    const soundAnalysis = extractSoundProfilesWithEssentia(
      essentia,
      samples,
      data.sampleRate,
      rhythm.beats
    );
    const beatmap = buildBeatmapFromAnalysis({
      ...rhythm,
      duration: data.duration,
      energy,
      ...soundAnalysis,
    });
    if (!isPlayableBeatmap(beatmap)) {
      throw new Error('분석 결과로 플레이 가능한 맵을 만들지 못했습니다.');
    }

    self.postMessage({ type: 'result', beatmap });
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (essentia) {
      essentia.shutdown();
      essentia.delete();
    }
  }
};
