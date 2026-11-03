import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ runs: [] as Array<{ audio: Float32Array; finish: () => void }> }));
vi.mock('@huggingface/transformers', () => ({
  env: { backends: { onnx: {} } },
  pipeline: async () => Object.assign(
    (audio: Float32Array) => new Promise((resolve) => mock.runs.push({ audio, finish: () => resolve({ text: `heard ${audio[0]}` }) })),
    { dispose: async () => {} },
  ),
}));

describe('speech recognition worker backlog', () => {
  let worker: { location: { origin: string }; postMessage: ReturnType<typeof vi.fn>; onmessage: (event: { data: unknown }) => void };
  const send = (id: number) => worker.onmessage({ data: { type: 'transcribe', id, audio: new Float32Array([id]), language: 'en', model: 'whisper-base' } });

  beforeEach(async () => {
    vi.resetModules();
    mock.runs.length = 0;
    worker = { location: { origin: 'http://localhost' }, postMessage: vi.fn(), onmessage: () => {} };
    vi.stubGlobal('self', worker);
    vi.stubGlobal('navigator', {});
    await import('./stt.worker.ts');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps one run in flight and lets the newest segment replace the waiting one', async () => {
    send(1);
    await vi.waitFor(() => expect(mock.runs).toHaveLength(1));
    send(2);
    send(3);
    send(4);
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'superseded', id: 2 });
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'superseded', id: 3 });
    mock.runs[0].finish();
    await vi.waitFor(() => expect(mock.runs).toHaveLength(2));
    expect(mock.runs[1].audio[0]).toBe(4);
    mock.runs[1].finish();
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith({ type: 'text', id: 4, text: 'heard 4' }));
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'text', id: 1, text: 'heard 1' });
    expect(mock.runs).toHaveLength(2);
  });

  it('identifies inference start and the final result with the original turn and epoch', async () => {
    const token = { turnId: 7, speechEpoch: 8, generation: 9 };
    worker.onmessage({ data: { ...token, type: 'transcribe', id: 1, audio: new Float32Array([1]), model: 'whisper-base', language: 'en' } });
    await vi.waitFor(() => expect(mock.runs).toHaveLength(1));
    expect(worker.postMessage).toHaveBeenCalledWith({ ...token, type: 'started', id: 1 });
    mock.runs[0].finish();
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith({ ...token, type: 'text', id: 1, text: 'heard 1' }));
  });
});
