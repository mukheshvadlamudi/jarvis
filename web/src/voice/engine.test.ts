import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const vad = vi.hoisted(() => ({ options: null as null | { onVADMisfire: () => void; onSpeechEnd: (audio: Float32Array) => void } }));
vi.mock('@ricky0123/vad-web', () => ({ MicVAD: { new: async (options: typeof vad.options) => {
  vad.options = options;
  return { start: async () => {}, destroy: async () => {} };
} } }));

describe('voice engine feedback and preferences', () => {
  const workers: FakeWorker[] = [];
  class FakeWorker {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: unknown;
    postMessage = vi.fn();
    terminate = vi.fn();
    constructor() { workers.push(this); }
    emit(data: unknown) { this.onmessage?.({ data }); }
  }
  let saved: Record<string, unknown>;
  let engine: typeof import('./engine.ts');
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    saved = {};
    workers.length = 0;
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(saved), setItem: (_key: string, value: string) => { saved = JSON.parse(value); } });
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('AudioContext', class { state = 'running'; });
    engine = await import('./engine.ts');
  });
  afterEach(async () => { await engine.voice.stop(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('defaults to Heart/Best and migrates only the unchosen old default', () => {
    expect(engine.loadPrefs()).toMatchObject({ voice: 'af_heart', voiceQuality: 'best' });
    saved = { voice: 'bm_george' };
    expect(engine.loadPrefs().voice).toBe('af_heart');
    saved = { voice: 'bm_george', voiceChosen: true };
    expect(engine.loadPrefs().voice).toBe('bm_george');
    saved = { voice: 'af_bella' };
    expect(engine.loadPrefs().voice).toBe('af_bella');
    engine.voice.setPrefs({ voice: 'bm_george' });
    expect(saved).toMatchObject({ voice: 'bm_george', voiceChosen: true });
  });

  it('shows short speech feedback briefly', async () => {
    await engine.voice.start();
    vad.options!.onVADMisfire();
    expect(engine.voice.state).toMatchObject({ status: 'listening', outcome: 'Too short, try again' });
    await vi.advanceTimersByTimeAsync(7000);
    expect(engine.voice.state.outcome).toBe('');
  });

  it.each(['', 'you', 'thank you.', '[BLANK_AUDIO]', '(silence)'])('does not dispatch noise: %s', async (text) => {
    await engine.voice.start();
    const utterance = vi.fn();
    engine.voice.onUtterance = utterance;
    vad.options!.onSpeechEnd(new Float32Array(16000));
    expect(engine.voice.state.outcome).toBe('Transcribing…');
    const request = workers[1].postMessage.mock.calls.at(-1)![0];
    workers[1].emit({ type: 'text', id: request.id, text });
    await Promise.resolve();
    expect(utterance).not.toHaveBeenCalled();
    expect(engine.voice.state.outcome).toBe('Not sure what you meant');
  });

  it('keeps the TTS device when recognition loads on another device', () => {
    engine.voice.preload();
    workers[0].emit({ type: 'ready', what: 'voice', device: 'webgpu' });
    workers[1].emit({ type: 'ready', what: 'ears', device: 'wasm' });
    expect(engine.voice.state.device).toBe('webgpu');
    expect(engine.voiceEngineStatus(engine.voice.state)).toBe('Natural voice · Graphics card (WebGPU)');
  });

  it('reports download/failure and reloads with the selected quality', () => {
    engine.voice.preload();
    workers[0].emit({ type: 'progress', what: 'voice', file: 'model', progress: 79 });
    expect(engine.voiceEngineStatus(engine.voice.state)).toBe('System voice · natural voice downloading 79%');
    workers[0].emit({ type: 'error', what: 'voice', message: 'Download blocked' });
    expect(engine.voiceEngineStatus(engine.voice.state)).toContain('natural voice failed to load: Download blocked');
    engine.voice.setPrefs({ voiceQuality: 'light' });
    expect(workers[0].terminate).toHaveBeenCalled();
    expect(workers[2].postMessage).toHaveBeenCalledWith({ type: 'load', quality: 'light' });
    expect(engine.voice.state.naturalError).toBeNull();
  });

  it('uses the ignored utterance once and keeps its text visible', async () => {
    engine.voice.state = { ...engine.voice.state, heard: 'research backups' };
    engine.voice.feedback('Start with Jarvis', true, true);
    engine.voice.onUseHeard = vi.fn(async () => {});
    await engine.voice.useHeard();
    await engine.voice.useHeard();
    expect(engine.voice.onUseHeard).toHaveBeenCalledExactlyOnceWith('research backups');
    expect(engine.voice.state.heard).toBe('research backups');
    expect(engine.voice.state.outcome).toBe('Opening a conversation…');
  });
});
