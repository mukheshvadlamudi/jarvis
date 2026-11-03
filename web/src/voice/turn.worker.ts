/// <reference lib="webworker" />
import { WhisperFeatureExtractor } from '@huggingface/transformers';
import { InferenceSession, Tensor, env } from 'onnxruntime-web/webgpu';
import { SMART_REVISION, turnWaveform, WHISPER_CONFIG } from './turn.ts';
import type { VoiceToken } from './turn.ts';

const extractor = new WhisperFeatureExtractor(WHISPER_CONFIG);
let session: Promise<InferenceSession> | null = null;
self.onmessage = async (event: MessageEvent<VoiceToken & { id: number; audio: Float32Array }>) => {
  const { audio, ...token } = event.data;
  try {
    env.wasm.numThreads = 1;
    env.wasm.wasmPaths = self.location.origin + '/voice-runtime/ort/';
    session ??= InferenceSession.create(`https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/${SMART_REVISION}/smart-turn-v3.2-cpu.onnx`, { executionProviders: ['wasm'] });
    const model = await session;
    const features = await extractor._call(turnWaveform(audio));
    const result = await model.run({ input_features: new Tensor('float32', features.input_features.data as Float32Array, [1, 80, 800]) });
    const probability = Number(result[model.outputNames[0]].data[0]);
    if (!Number.isFinite(probability)) throw new Error('Invalid completion probability');
    self.postMessage({ ...token, type: 'decision', probability });
  } catch (error) {
    self.postMessage({ ...token, type: 'error', message: (error as Error).message });
  }
};
