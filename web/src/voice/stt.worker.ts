/// <reference lib="webworker" />
// Whisper speech-to-text on this device. Receives 16 kHz mono audio from the voice-activity detector.
import { modelProgress } from './loading.ts';
import { env, pipeline } from '@huggingface/transformers';

type In = { type: 'load'; model: string } | { type: 'transcribe'; id: number; audio: Float32Array; language: string; model: string };
type Asr = ((audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string } | Array<{ text: string }>>) & { dispose: () => Promise<void> };

let asr: Asr | null = null;
let current = '';
const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

async function load(model: string): Promise<Asr> {
  if (asr && current === model) return asr;
  await asr?.dispose();
  asr = null;
  env.allowLocalModels = false;
  if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = `${self.location.origin}/voice-runtime/ort/`;
  const webgpu = 'gpu' in navigator && !!(await (navigator as unknown as { gpu: { requestAdapter: () => Promise<unknown> } }).gpu.requestAdapter().catch(() => null));
  const progress_callback = await modelProgress(`onnx-community/${model}`,
    ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'preprocessor_config.json',
      `onnx/encoder_model${webgpu ? '' : '_quantized'}.onnx`,
      `onnx/decoder_model_merged${webgpu ? '_q4' : '_quantized'}.onnx`],
    (load) => post({ type: 'model-load', what: 'ears', load }));
  asr = (await pipeline('automatic-speech-recognition', `onnx-community/${model}`, {
    device: webgpu ? 'webgpu' : 'wasm',
    dtype: webgpu ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
    progress_callback,
  } as never)) as unknown as Asr;
  current = model;
  post({ type: 'ready', what: 'ears', device: webgpu ? 'webgpu' : 'wasm' });
  return asr;
}

async function handle(m: In) {
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
}
let queue = Promise.resolve();
self.onmessage = (e: MessageEvent<In>) => { queue = queue.then(() => handle(e.data)); };
