import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('kokoro-js', () => ({ KokoroTTS: { from_pretrained: mock.create }, env: {} }));

describe('natural voice worker', () => {
  let worker: { location: { origin: string }; postMessage: ReturnType<typeof vi.fn>; onmessage: (event: { data: unknown }) => void };
  let gpu: { requestAdapter: ReturnType<typeof vi.fn> };
  const audio = () => ({ audio: new Float32Array([0, 1]), sampling_rate: 24000 });
  const model = () => ({ generate: vi.fn(async () => audio()), model: { dispose: vi.fn(async () => {}) } });
  const send = async (data: unknown) => { worker.onmessage({ data }); await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled()); };
  const settled = async (type: string) => vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type }), expect.any(Array)));

  beforeEach(async () => {
    vi.resetModules();
    mock.create.mockReset().mockResolvedValue(model());
    worker = { location: { origin: 'http://localhost' }, postMessage: vi.fn(), onmessage: () => {} };
    gpu = { requestAdapter: vi.fn().mockResolvedValue({ isFallbackAdapter: false }) };
    vi.stubGlobal('self', worker);
    vi.stubGlobal('navigator', { gpu });
    await import('./tts.worker.ts');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('retries high performance when the default adapter is null', async () => {
    gpu.requestAdapter.mockResolvedValueOnce(null);
    await send({ type: 'load', quality: 'best' });
    await settled('ready');
    expect(gpu.requestAdapter).toHaveBeenLastCalledWith({ powerPreference: 'high-performance' });
    expect(mock.create).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ device: 'webgpu', dtype: 'fp32' }));
  });

  it('uses fp32 on CPU when both adapters are unavailable', async () => {
    gpu.requestAdapter.mockResolvedValue(null);
    await send({ type: 'load', quality: 'best' });
    await settled('ready');
    expect(mock.create).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ device: 'wasm', dtype: 'fp32' }));
  });

  it('rejects software adapters', async () => {
    gpu.requestAdapter.mockResolvedValue({ isFallbackAdapter: true });
    await send({ type: 'load', quality: 'best' });
    await settled('ready');
    expect(mock.create).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ device: 'wasm', dtype: 'fp32' }));
  });

  it('uses q8 CPU for Light without probing the GPU', async () => {
    await send({ type: 'load', quality: 'light' });
    await settled('ready');
    expect(gpu.requestAdapter).not.toHaveBeenCalled();
    expect(mock.create).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ device: 'wasm', dtype: 'q8' }));
  });

  it('reports GPU init failure and retries with q8 CPU', async () => {
    mock.create.mockRejectedValueOnce(new Error('GPU out of memory'));
    await send({ type: 'load', quality: 'best' });
    await settled('ready');
    expect(mock.create).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ device: 'wasm', dtype: 'q8' }));
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ fallback: expect.stringContaining('GPU out of memory') }), []);
  });

  it('retries synthesis on CPU and reports the fallback', async () => {
    const first = model();
    first.generate.mockRejectedValueOnce(new Error('GPU lost'));
    mock.create.mockResolvedValueOnce(first).mockResolvedValueOnce(model());
    await send({ type: 'load', quality: 'best' });
    await settled('ready');
    worker.postMessage.mockClear();
    await send({ type: 'speak', id: 1, text: 'Backups are ready.', voice: 'af_heart', speed: 1 });
    await settled('audio');
    expect(first.model.dispose).toHaveBeenCalled();
    expect(mock.create).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ device: 'wasm', dtype: 'q8' }));
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ fallback: expect.stringContaining('GPU lost') }), []);
  });

  it('reports an unrecoverable CPU load error', async () => {
    mock.create.mockRejectedValue(new Error('Download failed'));
    await send({ type: 'load', quality: 'light' });
    await settled('error');
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ what: 'voice', message: 'Download failed' }), []);
  });
});
