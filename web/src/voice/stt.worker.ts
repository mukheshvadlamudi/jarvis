/// <reference lib="webworker" />
// Whisper speech-to-text on this device. Receives 16 kHz mono audio from the voice-activity detector.
import { env, pipeline } from '@huggingface/transformers';

type In = { type: 'load'; model: string } | { type: 'transcribe'; id: number; audio: Float32Array; language: string; model: string };
type Asr = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string } | Array<{ text: string }>>;

let asr: Asr | null = null;
let current = '';
const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

async function load(model: string): Promise<Asr> {
  if (asr && current === model) return asr;
  env.allowLocalModels = false;
  if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = `${self.location.origin}/voice-runtime/ort/`;
  const webgpu = 'gpu' in navigator && !!(await (navigator as unknown as { gpu: { requestAdapter: () => Promise<unknown> } }).gpu.requestAdapter().catch(() => null));
  asr = (await pipeline('automatic-speech-recognition', `onnx-community/${model}`, {
    device: webgpu ? 'webgpu' : 'wasm',
    dtype: webgpu ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
    progress_callback: (p: { status: string; progress?: number; file?: string }) => {
      if (p.status === 'progress') post({ type: 'progress', what: 'ears', file: p.file, progress: p.progress ?? 0 });
    },
  } as never)) as unknown as Asr;
  current = model;
  post({ type: 'ready', what: 'ears', device: webgpu ? 'webgpu' : 'wasm' });
  return asr;
}

self.onmessage = async (e: MessageEvent<In>) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      await load(m.model);
      return;
    }
    const run = await load(m.model);
    const out = await run(m.audio, { language: m.language === 'auto' ? null : m.language, task: 'transcribe', chunk_length_s: 30 });
    const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text).trim();
    post({ type: 'text', id: m.id, text });
  } catch (err) {
    post({ type: 'error', what: 'ears', id: 'id' in m ? m.id : null, message: (err as Error).message });
  }
};
