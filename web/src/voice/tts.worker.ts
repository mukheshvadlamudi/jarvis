/// <reference lib="webworker" />
// Kokoro-82M text-to-speech, entirely on this device (WebGPU when available, otherwise WASM).
import { KokoroTTS, env } from 'kokoro-js';
import { sentences } from './speech.ts';

type In = { type: 'load' } | { type: 'speak'; id: number; text: string; voice: string; speed: number } | { type: 'cancel' } | { type: 'prewarm'; phrases: string[]; voice: string; speed: number };

let tts: KokoroTTS | null = null;
let current = 0;
/** Rendered short phrases ("Yes?", "On it.") play instantly the next time. */
const cache = new Map<string, { samples: Float32Array; rate: number }>();
const CACHE_MAX = 80;
const key = (voice: string, speed: number, text: string) => `${voice}|${speed}|${text}`;

async function render(model: KokoroTTS, text: string, voice: string, speed: number) {
  const k = key(voice, speed, text);
  const hit = cache.get(k);
  if (hit) return { samples: hit.samples.slice(), rate: hit.rate };
  const audio = await model.generate(text, { voice: voice as never, speed });
  const out = { samples: audio.audio as Float32Array, rate: audio.sampling_rate };
  if (text.length <= 48) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(k, { samples: out.samples.slice(), rate: out.rate });
  }
  return out;
}
let loading: Promise<KokoroTTS> | null = null;
const post = (m: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

async function load(): Promise<KokoroTTS> {
  if (tts) return tts;
  loading ??= (async () => {
    env.wasmPaths = `${self.location.origin}/voice-runtime/ort/`;
    const webgpu = 'gpu' in navigator && !!(await (navigator as unknown as { gpu: { requestAdapter: () => Promise<unknown> } }).gpu.requestAdapter().catch(() => null));
    const model = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype: webgpu ? 'fp32' : 'q8',
      device: webgpu ? 'webgpu' : 'wasm',
      progress_callback: (p: { status: string; progress?: number; file?: string }) => {
        if (p.status === 'progress') post({ type: 'progress', what: 'voice', file: p.file, progress: p.progress ?? 0 });
      },
    });
    tts = model;
    post({ type: 'ready', what: 'voice', device: webgpu ? 'webgpu' : 'wasm' });
    return model;
  })();
  return loading;
}

self.onmessage = async (e: MessageEvent<In>) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      await load();
      return;
    }
    if (m.type === 'cancel') {
      current = 0;
      return;
    }
    if (m.type === 'prewarm') {
      // Warm the runtime and cache the replies Jarvis says most, while idle.
      const model = await load();
      for (const p of m.phrases) {
        if (current) await new Promise((r) => setTimeout(r, 250));
        await render(model, p, m.voice, m.speed);
      }
      return;
    }
    current = m.id;
    const model = await load();
    const chunks = sentences(m.text);
    for (const [i, chunk] of chunks.entries()) {
      if (current !== m.id) return; // superseded (barge-in or a newer reply)
      const { samples, rate } = await render(model, chunk, m.voice, m.speed);
      post({ type: 'audio', id: m.id, index: i, last: i === chunks.length - 1, samples, rate }, [samples.buffer]);
    }
    if (current === m.id) current = 0;
  } catch (err) {
    post({ type: 'error', what: 'voice', id: 'id' in m ? m.id : null, message: (err as Error).message });
  }
};
