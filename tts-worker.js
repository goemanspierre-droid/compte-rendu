// Voix intégrée : synthèse vocale française directement sur le téléphone (modèle MMS-TTS via transformers.js)
import { pipeline, env } from './vendor/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true; // le modèle (~115 Mo) reste en cache après le 1er téléchargement
env.useWasmCache = true;

const MODEL = 'Xenova/mms-tts-fra';
let tts = null, device = '';

async function load(id) {
  if (tts) return tts;
  const files = {};
  const progress_callback = (p) => {
    if (p.status === 'progress' && p.total) {
      files[p.file] = p;
      const tot = Object.values(files).reduce((a, f) => a + f.total, 0);
      const ld = Object.values(files).reduce((a, f) => a + f.loaded, 0);
      self.postMessage({ id, type: 'progress', stage: 'load', p: ld / tot });
    }
  };
  try {
    if (self.navigator && 'gpu' in self.navigator && (await self.navigator.gpu.requestAdapter())) {
      tts = await pipeline('text-to-speech', MODEL, { dtype: 'fp32', device: 'webgpu', progress_callback });
      device = 'webgpu';
    }
  } catch (e) { tts = null; }
  if (!tts) { tts = await pipeline('text-to-speech', MODEL, { dtype: 'fp32', device: 'wasm', progress_callback }); device = 'wasm'; }
  return tts;
}

self.onmessage = async (e) => {
  const { id, type, items } = e.data;
  try {
    const p = await load(id);
    if (type === 'load') { self.postMessage({ id, type: 'done', device }); return; }
    const parts = []; let sr = 16000;
    for (let i = 0; i < items.length; i++) {
      self.postMessage({ id, type: 'progress', stage: 'synth', p: i / items.length });
      const o = await p(items[i].s);
      sr = o.sampling_rate;
      parts.push(o.audio, new Float32Array(Math.round(sr * (items[i].pause || 0.3))));
    }
    const len = parts.reduce((a, b) => a + b.length, 0), out = new Float32Array(len);
    let off = 0; for (const x of parts) { out.set(x, off); off += x.length; }
    self.postMessage({ id, type: 'done', audio: out, sr, device }, [out.buffer]);
  } catch (err) {
    self.postMessage({ id, type: 'error', error: String((err && err.message) || err) });
  }
};
