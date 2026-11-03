import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const vad = vi.hoisted(() => ({ options: null as null | { onVADMisfire: () => void; onSpeechEnd: (audio: Float32Array) => void; getStream: () => Promise<MediaStream>; positiveSpeechThreshold: number; negativeSpeechThreshold: number; minSpeechMs: number } }));
vi.mock('@ricky0123/vad-web', () => ({ MicVAD: { new: async (options: typeof vad.options) => {
  vad.options = options;
  let stream: MediaStream | undefined;
  return { start: async () => { stream = await options!.getStream(); }, destroy: async () => { stream?.getTracks().forEach((t) => t.stop()); } };
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
  let media: { enumerateDevices: ReturnType<typeof vi.fn>; getUserMedia: ReturnType<typeof vi.fn>; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };
  let stopTrack: ReturnType<typeof vi.fn>;
  let engine: typeof import('./engine.ts');
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    saved = {};
    workers.length = 0;
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(saved), setItem: (_key: string, value: string) => { saved = JSON.parse(value); } });
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('AudioContext', class { state = 'running'; });
    stopTrack = vi.fn();
    media = { enumerateDevices: vi.fn(async () => [{ kind: 'audioinput', deviceId: 'usb', label: 'Desk microphone' }]), getUserMedia: vi.fn(async () => ({ getAudioTracks: () => [{ label: 'Desk microphone' }], getTracks: () => [{ stop: stopTrack }] })), addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal('navigator', { mediaDevices: media, storage: { persist: vi.fn(async () => true) } });
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
    workers[0].emit({ type: 'model-load', what: 'voice', load: { status: 'loading', cached: false, loaded: 120e6, total: 326e6 } });
    expect(engine.voiceEngineStatus(engine.voice.state)).toBe('Natural voice \u00b7 Downloading voice model \u00b7 120 of 326 MB');
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

  it('restarts capture with the selected mic and sensitivity and reports the actual track', async () => {
    await engine.voice.start();
    expect(vad.options).toMatchObject({ positiveSpeechThreshold: 0.6, negativeSpeechThreshold: 0.45, minSpeechMs: 300 });
    engine.voice.setPrefs({ micId: 'usb', micSensitivity: 'high', noiseSuppression: false });
    await vi.waitFor(() => expect(media.getUserMedia).toHaveBeenCalledTimes(2));
    expect(stopTrack).toHaveBeenCalled();
    expect(media.getUserMedia).toHaveBeenLastCalledWith({ audio: expect.objectContaining({ deviceId: { exact: 'usb' }, noiseSuppression: false }) });
    expect(vad.options).toMatchObject({ positiveSpeechThreshold: 0.45, negativeSpeechThreshold: 0.3, minSpeechMs: 200 });
    expect(engine.voice.state.micLabel).toBe('Desk microphone');
    expect(engine.voice.state.persisted).toBe(true);
  });

  it('reports fallback in the dock state when the saved device is gone', async () => {
    engine.voice.setPrefs({ micId: 'unplugged' });
    await engine.voice.start();
    expect(engine.voice.state.micFallback).toContain('using system default');
    expect(media.getUserMedia).toHaveBeenCalledWith({ audio: expect.objectContaining({ deviceId: undefined }) });
    expect(saved.micId).toBe('unplugged');
  });

  it('responds to device removal while listening and reacquires the default', async () => {
    engine.voice.setPrefs({ micId: 'usb' });
    await engine.voice.start();
    media.enumerateDevices.mockResolvedValue([{ kind: 'audioinput', deviceId: 'built-in', label: 'Laptop microphone' }]);
    const changed = media.addEventListener.mock.calls.find(([name]) => name === 'devicechange')![1];
    changed();
    await vi.waitFor(() => expect(media.getUserMedia).toHaveBeenCalledTimes(2));
    expect(engine.voice.state.micFallback).toContain('using system default');
    expect(stopTrack).toHaveBeenCalled();
  });

  it('continues listening when persistent storage is denied or throws', async () => {
    vi.spyOn(navigator.storage, 'persist').mockRejectedValue(new Error('denied'));
    await engine.voice.start();
    expect(engine.voice.state).toMatchObject({ persisted: false, status: 'listening' });
  });

  it.each([true, false])('defaults model retention to WebGPU availability: %s', async (available) => {
    vi.stubGlobal('navigator', { mediaDevices: media, ...(available ? { gpu: {} } : {}) });
    vi.resetModules();
    engine = await import('./engine.ts');
    expect(engine.loadPrefs().keepLoaded).toBe(available);
    expect(engine.loadPrefs().sttModel).toBe('whisper-base');
  });

  it('keeps ready models between wakes, and releases them when retention is disabled', async () => {
    engine.voice.setPrefs({ keepLoaded: true });
    await engine.voice.start();
    workers[0].emit({ type: 'ready', what: 'voice', device: 'webgpu' });
    workers[1].emit({ type: 'ready', what: 'ears' });
    await engine.voice.stop();
    expect(stopTrack).toHaveBeenCalled();
    expect(workers[0].terminate).not.toHaveBeenCalled();
    workers.forEach((w) => w.postMessage.mockClear());
    await engine.voice.start();
    expect(workers).toHaveLength(2);
    expect(workers[0].postMessage).not.toHaveBeenCalled();
    expect(workers[1].postMessage).not.toHaveBeenCalled();
    await engine.voice.stop();
    engine.voice.setPrefs({ keepLoaded: false });
    expect(workers[0].terminate).toHaveBeenCalled();
    expect(workers[1].terminate).toHaveBeenCalled();
  });

  it('never switches to system speech while Kokoro loads or fails', async () => {
    const speak = vi.fn();
    vi.stubGlobal('speechSynthesis', { speak, getVoices: () => [], cancel: vi.fn() });
    // While loading, the line is held for the natural voice instead of the robotic one…
    const first = engine.voice.speak('Hello');
    expect(engine.voice.state.outcome).toContain('will say this when it is ready');
    // …and released (not spoken by the system voice) if loading fails.
    workers[0].emit({ type: 'error', what: 'voice', message: 'Load failed' });
    await first;
    await engine.voice.speak('Hello again');
    expect(speak).not.toHaveBeenCalled();
    expect(engine.voice.state.outcome).toContain('retry in Settings');
  });
});
