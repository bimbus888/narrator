// Runs the free Kokoro-82M voice model (Apache-2.0) on this device and encodes MP3.
// Model files download once from huggingface.co and are then cached by the browser.
import { KokoroTTS } from './vendor/kokoro.web.js';
import { Mp3Encoder } from './vendor/lamejs.js';
import { SAMPLE_RATE, BITRATE } from './lib.js';

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
let ttsPromise;

async function loadModel() {
  const progress_callback = p => p.status === 'progress' && postMessage({ type: 'load', file: p.file, progress: p.progress });
  const mobile = /iPhone|iPad|Android/.test(navigator.userAgent) || navigator.maxTouchPoints > 1;
  if (!mobile && navigator.gpu && await navigator.gpu.requestAdapter().catch(() => null)) {
    try {
      const tts = await KokoroTTS.from_pretrained(MODEL, { dtype: 'fp32', device: 'webgpu', progress_callback });
      postMessage({ type: 'device', device: 'webgpu' });
      return tts;
    } catch (e) { console.warn('WebGPU failed, falling back to WASM', e); }
  }
  // fp32 is ~1.5x faster than q8 on CPU but 3.5x larger (~330 MB), so phones get the smaller q8 model
  const tts = await KokoroTTS.from_pretrained(MODEL, { dtype: mobile ? 'q8' : 'fp32', device: 'wasm', progress_callback });
  postMessage({ type: 'device', device: 'wasm' });
  return tts;
}

function toInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) out[i] = Math.max(-1, Math.min(1, f32[i])) * 0x7fff;
  return out;
}

onmessage = async ({ data: m }) => {
  try {
    ttsPromise ??= loadModel().catch(e => { ttsPromise = null; throw e; });
    const tts = await ttsPromise;
    if (m.type === 'load') return postMessage({ type: 'ready', id: m.id });
    const encoder = new Mp3Encoder(1, SAMPLE_RATE, BITRATE), mp3 = [];
    const push = samples => { for (let i = 0; i < samples.length; i += 1152) mp3.push(encoder.encodeBuffer(samples.subarray(i, i + 1152))); };
    for (let i = 0; i < m.parts.length; i++) {
      const { audio } = await tts.generate(m.parts[i], { voice: m.voice, speed: 0.95 });
      push(toInt16(audio));
      push(new Int16Array(Math.round(SAMPLE_RATE * (i === 0 && m.heading ? 1.0 : 0.25)))); // pause between sentences
    }
    mp3.push(encoder.flush());
    postMessage({ type: 'done', id: m.id, blob: new Blob(mp3, { type: 'audio/mpeg' }) });
  } catch (e) {
    postMessage({ type: 'error', id: m.id, message: String(e?.message || e) });
  }
};
