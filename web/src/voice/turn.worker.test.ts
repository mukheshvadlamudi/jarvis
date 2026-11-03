import { afterEach, expect, it, vi } from 'vitest';
const model = vi.hoisted(() => ({ run: vi.fn(), create: vi.fn() }));
vi.mock('onnxruntime-web/webgpu', () => ({ env: { wasm: {} }, Tensor: class { constructor(..._args: unknown[]) {} }, InferenceSession: { create: model.create } }));
vi.mock('@huggingface/transformers', () => ({ WhisperFeatureExtractor: class { _call = async () => ({ input_features: { data: new Float32Array(64000) } }); } }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
it('runs pinned WASM inference and returns the full request identity', async () => {
  const worker = { location: { origin: 'http://localhost' }, onmessage: null as unknown as (e: { data: unknown }) => Promise<void>, postMessage: vi.fn() };
  vi.stubGlobal('self', worker);
  model.create.mockResolvedValue({ run: model.run, outputNames: ['probability'] });
  model.run.mockResolvedValue({ probability: { data: new Float32Array([0.75]) } });
  await import('./turn.worker.ts');
  const token = { id: 3, turnId: 4, speechEpoch: 5, generation: 6 };
  await worker.onmessage({ data: { ...token, audio: new Float32Array(16000) } });
  expect(model.create).toHaveBeenCalledWith(expect.stringContaining('/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93/smart-turn-v3.2-cpu.onnx'), { executionProviders: ['wasm'] });
  expect(worker.postMessage).toHaveBeenLastCalledWith({ ...token, type: 'decision', probability: 0.75 });
  model.run.mockRejectedValueOnce(new Error('WASM failed'));
  await worker.onmessage({ data: { ...token, audio: new Float32Array(16000) } });
  expect(worker.postMessage).toHaveBeenLastCalledWith({ ...token, type: 'error', message: 'WASM failed' });
});
