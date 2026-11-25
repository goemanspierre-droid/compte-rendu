// Transcription locale (sur le téléphone) avec Whisper via transformers.js
import { pipeline, env } from './vendor/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true; // les modèles restent en cache après le 1er téléchargement
// Le moteur WebAssembly (~27 Mo) est chargé depuis le CDN jsDelivr au 1er usage puis gardé en cache
env.useWasmCache = true;

let asr = null;
let current = null;

async function load(model, id) {
  if (asr && current === model) return asr;
  const progress_callback = (p) => {
    if (p.status === 'progress' && p.total) {
      self.postMessage({ id, type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
    }
  };
  const tryDevice = async (device) => {
    const dtype = device === 'webgpu'
      ? { encoder_model: 'fp32', decoder_model_merged: 'q4' }
      : 'q8';
    return pipeline('automatic-speech-recognition', model, { device, dtype, progress_callback });
  };
  let device = 'wasm';
  try {
    if (self.navigator && 'gpu' in self.navigator && (await self.navigator.gpu.requestAdapter())) {
      asr = await tryDevice('webgpu');
      device = 'webgpu';
    }
  } catch (e) { asr = null; }
  if (!asr) asr = await tryDevice('wasm');
  current = model;
  self.postMessage({ id, type: 'device', device });
  return asr;
}

self.onmessage = async (e) => {
  const { id, type, model, audio, language } = e.data;
  try {
    if (type === 'load') {
      await load(model, id);
      self.postMessage({ id, type: 'done' });
    } else if (type === 'transcribe') {
      const p = await load(model, id);
      const out = await p(audio, {
        language: language || 'french',
        task: 'transcribe',
        chunk_length_s: 30,
        stride_length_s: 5,
      });
      self.postMessage({ id, type: 'done', text: (out.text || '').trim() });
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', error: String(err && err.message || err) });
  }
};
