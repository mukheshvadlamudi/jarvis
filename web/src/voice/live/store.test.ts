import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ options: null as any, vad: null as any, worklet: null as any, flush: vi.fn(), enqueue: vi.fn(), send: vi.fn(), tool: vi.fn(), speech: vi.fn(), post: vi.fn(), api: vi.fn(), listeners: new Set<() => void>(), live: null as any }));
vi.mock('../../lib/router.ts', () => ({ navigate: vi.fn() }));
vi.mock('../../lib/api.ts', () => ({ api: f.api, post: f.post }));
vi.mock('../../lib/live.ts', () => ({ subscribeLive: (fn: any) => { f.live = fn; return () => { f.live = null; }; } }));
vi.mock('../microphone.ts', () => ({ openMicrophone: async () => ({ stream: { getTracks: () => [{ stop: vi.fn() }] }, missing: false }) }));
vi.mock('@ricky0123/vad-web', () => ({ MicVAD: { new: async (options: any) => { f.vad = options; return { destroy: vi.fn(async () => {}) }; } } }));
vi.mock('../engine.ts', () => ({ voice: {
  state: { status: 'off', muted: false, level: 0, error: null, prefs: { enabled: false, micId: '', interruptions: 'speaker-safe' } },
  focusedSession: false, pushToTalk: false, outputLevel: 0,
  onUtterance: null, onTurnStart: null, onStopSpeaking: null, onRecognitionEnd: null,
  setFocusedSession(value: boolean) { this.focusedSession = value; },
  async stop() { this.state.status = 'off'; this.state.prefs.enabled = false; },
  async start() { this.state.status = 'listening'; this.state.prefs.enabled = true; },
  subscribe: (fn: () => void) => { f.listeners.add(fn); return () => f.listeners.delete(fn); },
  speak: f.speech, stopSpeaking: vi.fn(), muteMic: vi.fn(), setPrefs: vi.fn(),
} }));
vi.mock('./client.ts', () => ({ quotaFailure: (error: Error) => /429|quota/.test(error.message), LiveClient: class {
  model = 'gemini-3.8-live';
  session = { sendRealtimeInput: f.send, sendToolResponse: f.tool, sendClientContent: vi.fn(), close: vi.fn() };
  constructor(options: any) { f.options = options; }
  async start() { f.options.state('Connected'); }
  stop() {}
} }));
vi.mock('./audio.ts', async (original) => ({ ...await original<typeof import('./audio.ts')>(), PlaybackQueue: class {
  speaking = false; level = 0.2; flush = f.flush; enqueue = f.enqueue; close = vi.fn();
} }));

describe('shared voice session, with fake devices, agents and Gemini', () => {
  let session: typeof import('./store.ts').voiceSession;
  beforeEach(async () => {
    vi.useFakeTimers(); vi.clearAllMocks();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('AudioContext', class {
      sampleRate = 48000; destination = {}; audioWorklet = { addModule: vi.fn(async () => {}) };
      resume = vi.fn(async () => {}); close = vi.fn(async () => {});
      createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
    });
    vi.stubGlobal('AudioWorkletNode', class { port = { onmessage: null as any }; connect = vi.fn(); disconnect = vi.fn(); constructor() { f.worklet = this; } });
    f.api.mockImplementation(async (path: string) => path.includes('/usage') ? { inSec: 0, outSec: 0 } : path === '/api/voice/live' ? { configured: true, model: 'gemini-3.8-live' } : path.includes('/conversations/') ? { runs: [] } : { saved: 'Inbox.md' });
    f.post.mockResolvedValue({ inSec: 0, outSec: 0, conversationId: 'chat' });
    session = (await import('./store.ts')).voiceSession;
    session.set({ status: 'off', brain: 'gemini', input: '', output: '', error: '', notice: '', lines: [], conversationId: 'chat' });
  });
  afterEach(async () => { await session.end(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  it('flushes output on interrupted, persists captions, and keeps the session when views switch', async () => {
    await session.start('chat'); expect(session.state.status).toBe('listening');
    f.options.message({ serverContent: { inputTranscription: { text: 'Hello' }, outputTranscription: { text: 'Hi there.' }, modelTurn: { parts: [{ inlineData: { data: 'AAA=', mimeType: 'audio/pcm;rate=24000' } }] } } });
    expect(f.enqueue).toHaveBeenCalledOnce();
    f.options.message({ serverContent: { interrupted: true } }); expect(f.flush).toHaveBeenCalledOnce();
    session.set({ fullView: true }); session.set({ fullView: false }); expect(session.state.status).not.toBe('off');
    f.options.message({ serverContent: { turnComplete: true } }); await Promise.resolve(); await Promise.resolve();
    expect(f.post).toHaveBeenCalledWith('/api/conversations/chat/voice-turns', { user: 'Hello', assistant: 'Hi there.' });
  });
  it('gates input with Silero and records only transmitted audio', async () => {
    await session.start('chat'); const frame = new Float32Array(1536).fill(0.1);
    f.worklet.port.onmessage({ data: frame }); expect(f.send).not.toHaveBeenCalled();
    f.vad.onFrameProcessed({ isSpeech: 0.9 }); f.vad.onSpeechStart(); f.worklet.port.onmessage({ data: frame });
    expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ audio: expect.objectContaining({ mimeType: 'audio/pcm;rate=16000' }) }));
    f.vad.onSpeechEnd(); expect(f.send).toHaveBeenLastCalledWith({ audioStreamEnd: true });
    await session.flushUsage(); expect(f.post).toHaveBeenCalledWith('/api/voice/live/usage', { inSec: 0.064, outSec: 0 });
  });
  it('returns tools with WHEN_IDLE scheduling and errors with INTERRUPT', async () => {
    await session.start('chat');
    f.options.message({ toolCall: { functionCalls: [{ id: 'tool1', name: 'remember', args: { text: 'A note' } }] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.tool).toHaveBeenCalledWith({ functionResponses: [expect.objectContaining({ id: 'tool1', scheduling: 'WHEN_IDLE' })] });
    f.options.message({ toolCall: { functionCalls: [{ id: 'tool2', name: 'unknown' }] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.tool).toHaveBeenLastCalledWith({ functionResponses: [expect.objectContaining({ id: 'tool2', scheduling: 'INTERRUPT', response: expect.objectContaining({ error: expect.any(String) }) })] });
  });
  it('switches to Local on quota and speaks the explanation once', async () => {
    await session.start('chat');
    const fail = f.options.failure;
    fail(new Error('429 quota')); await vi.advanceTimersByTimeAsync(0);
    expect(session.state.brain).toBe('local');
    expect(session.state.notice).toBe("Gemini's free limit is reached; using local voice for now");
    fail(new Error('429 quota')); await vi.advanceTimersByTimeAsync(0);
    expect(f.speech).toHaveBeenCalledExactlyOnceWith("Gemini's free limit is reached; using local voice for now");
  });
  it('ends after two minutes without speech and clears every interval', async () => {
    await session.start('chat'); await vi.advanceTimersByTimeAsync(126200);
    expect(session.state.status).toBe('off'); expect(vi.getTimerCount()).toBe(0);
  });
});
