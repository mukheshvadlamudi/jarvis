import { useSyncExternalStore } from 'react';
import { sentences } from './speech.ts';

/** Per-device voice preferences (voice runs in this browser/app, so they live in localStorage). */
export interface VoicePrefs {
  enabled: boolean;
  /** kokoro: natural neural voice on this device (~600 MB RAM while on). system: the OS voice (no extra RAM). */
  engine: 'kokoro' | 'system';
  voice: string;
  speed: number;
  wakeWord: boolean;
  language: string;
  sttModel: 'whisper-base' | 'whisper-small' | 'whisper-tiny';
  speak: { approvals: boolean; finished: boolean; failed: boolean; notify: boolean; brief: boolean; confirmations: boolean };
}

export const DEFAULT_PREFS: VoicePrefs = {
  enabled: false,
  engine: 'kokoro',
  voice: 'bm_george',
  speed: 1,
  wakeWord: true,
  language: 'en',
  sttModel: 'whisper-base',
  speak: { approvals: true, finished: true, failed: true, notify: true, brief: true, confirmations: true },
};

export const VOICES: Array<{ id: string; label: string }> = [
  { id: 'bm_george', label: 'George — British, calm (default)' },
  { id: 'bm_lewis', label: 'Lewis — British, deeper' },
  { id: 'bm_daniel', label: 'Daniel — British, crisp' },
  { id: 'bm_fable', label: 'Fable — British, warm' },
  { id: 'bf_emma', label: 'Emma — British' },
  { id: 'bf_isabella', label: 'Isabella — British' },
  { id: 'am_michael', label: 'Michael — American' },
  { id: 'am_adam', label: 'Adam — American' },
  { id: 'af_heart', label: 'Heart — American, expressive' },
  { id: 'af_bella', label: 'Bella — American' },
];

const KEY = 'jarvis.voice';

/** Rendered (and cached) as soon as Kokoro loads, so the quick replies play with no wait. */
const PHRASES = ['Yes?', 'On it.', 'Approved.', 'Rejected. The agent will skip it.', 'Cancelled.', 'Nothing is running.', 'Approval needed.', 'Say approve or reject.', 'Good morning.', 'Systems online.'];
export function loadPrefs(): VoicePrefs {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<VoicePrefs>;
    return { ...DEFAULT_PREFS, ...p, speak: { ...DEFAULT_PREFS.speak, ...(p.speak ?? {}) } };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export type VoiceStatus = 'off' | 'loading' | 'idle' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'error';

export interface VoiceState {
  status: VoiceStatus;
  prefs: VoicePrefs;
  progress: { voice: number; ears: number };
  device: string | null;
  heard: string;
  said: string;
  awaiting: boolean;
  level: number;
  error: string | null;
  needsGesture: boolean;
}

type Listener = () => void;

/**
 * Local voice engine: Kokoro TTS + Whisper STT in workers, Silero VAD on the mic.
 * Nothing leaves the device and nothing costs credits.
 */
class VoiceEngine {
  state: VoiceState = { status: 'off', prefs: loadPrefs(), progress: { voice: 0, ears: 0 }, device: null, heard: '', said: '', awaiting: false, level: 0, error: null, needsGesture: false };
  private listeners = new Set<Listener>();
  private tts: Worker | null = null;
  private stt: Worker | null = null;
  private ctx: AudioContext | null = null;
  private vad: { start: () => Promise<void>; pause: () => Promise<void>; destroy: () => Promise<void> } | null = null;
  private nextId = 1;
  private playing: AudioBufferSourceNode[] = [];
  private playhead = 0;
  private speakId = 0;
  private speakDone: Map<number, () => void> = new Map();
  private sttWait: Map<number, (t: string) => void> = new Map();
  private ready = { voice: false, ears: false };
  private progressByFile: Record<'voice' | 'ears', Record<string, number>> = { voice: {}, ears: {} };
  onUtterance: ((text: string) => void) | null = null;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  private set(patch: Partial<VoiceState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  setPrefs(patch: Partial<VoicePrefs>) {
    if (patch.engine && patch.engine !== this.state.prefs.engine) {
      this.stopSpeaking();
      if (patch.engine === 'system') {
        this.tts?.terminate();
        this.tts = null;
        this.ready.voice = false;
        this.progressByFile.voice = {};
        this.set({ progress: { ...this.state.progress, voice: 0 } });
      }
    }
    const prefs = { ...this.state.prefs, ...patch, speak: { ...this.state.prefs.speak, ...(patch.speak ?? {}) } };
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      // storage blocked
    }
    this.set({ prefs });
    if ((patch.voice || patch.speed) && this.ready.voice) this.tts?.postMessage({ type: 'prewarm', phrases: PHRASES.slice(0, 4), voice: prefs.voice, speed: prefs.speed });
  }

  private onWorker = (e: MessageEvent) => {
    const m = e.data as { type: string; what?: 'voice' | 'ears'; file?: string; progress?: number; id?: number; samples?: Float32Array; rate?: number; last?: boolean; text?: string; message?: string; device?: string };
    if (m.type === 'progress' && m.what) {
      this.progressByFile[m.what][m.file ?? '?'] = m.progress ?? 0;
      const vals = Object.values(this.progressByFile[m.what]);
      this.set({ progress: { ...this.state.progress, [m.what]: Math.round(vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length)) } });
    } else if (m.type === 'ready' && m.what) {
      this.ready[m.what] = true;
      if (m.what === 'voice') this.tts?.postMessage({ type: 'prewarm', phrases: PHRASES, voice: this.state.prefs.voice, speed: this.state.prefs.speed });
      this.set({ progress: { ...this.state.progress, [m.what]: 100 }, device: m.device ?? this.state.device });
    } else if (m.type === 'audio' && m.samples && m.id === this.speakId) {
      this.enqueue(m.samples, m.rate ?? 24000, !!m.last, m.id);
    } else if (m.type === 'text' && m.id !== undefined) {
      this.sttWait.get(m.id)?.(m.text ?? '');
      this.sttWait.delete(m.id);
    } else if (m.type === 'error') {
      if (m.id !== undefined && m.id !== null) {
        this.sttWait.get(m.id)?.('');
        this.speakDone.get(m.id)?.();
      }
      this.set({ error: m.message ?? 'Voice error', status: this.state.status === 'loading' ? 'error' : this.state.status });
    }
  };

  private workers() {
    if (!this.tts) {
      this.tts = new Worker(new URL('./tts.worker.ts', import.meta.url), { type: 'module' });
      this.tts.onmessage = this.onWorker;
    }
    if (!this.stt) {
      this.stt = new Worker(new URL('./stt.worker.ts', import.meta.url), { type: 'module' });
      this.stt.onmessage = this.onWorker;
    }
  }

  private audio(): AudioContext {
    this.ctx ??= new AudioContext();
    return this.ctx;
  }

  /** Download/warm the models without starting the mic (Settings → "Download voice models"). */
  preload() {
    this.workers();
    if (this.state.prefs.engine === 'kokoro') this.tts!.postMessage({ type: 'load' });
    this.stt!.postMessage({ type: 'load', model: this.state.prefs.sttModel });
  }

  /** Free the models (Kokoro ~600 MB, Whisper ~150–450 MB) whenever voice is off. */
  private release() {
    this.tts?.terminate();
    this.stt?.terminate();
    this.tts = null;
    this.stt = null;
    this.ready = { voice: false, ears: false };
    this.progressByFile = { voice: {}, ears: {} };
    for (const r of this.sttWait.values()) r('');
    this.sttWait.clear();
    this.set({ progress: { voice: 0, ears: 0 }, device: null });
  }

  /** Turn hands-free voice on. Browsers need one user gesture for audio; the desktop app doesn't. */
  async start(): Promise<void> {
    if (this.state.status !== 'off' && this.state.status !== 'error') return;
    this.setPrefs({ enabled: true });
    this.set({ status: 'loading', error: null });
    try {
      this.workers();
      const ctx = this.audio();
      if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
      if (ctx.state === 'suspended') {
        this.set({ needsGesture: true });
        await new Promise<void>((resolve) => {
          const go = () => {
            void ctx.resume().then(() => resolve());
            window.removeEventListener('pointerdown', go);
            window.removeEventListener('keydown', go);
          };
          window.addEventListener('pointerdown', go);
          window.addEventListener('keydown', go);
        });
        this.set({ needsGesture: false });
      }
      this.preload();
      const { MicVAD } = await import('@ricky0123/vad-web');
      const vad = await MicVAD.new({
        model: 'v5',
        baseAssetPath: '/voice-runtime/vad/',
        onnxWASMBasePath: '/voice-runtime/vad/',
        positiveSpeechThreshold: 0.6,
        negativeSpeechThreshold: 0.4,
        redemptionMs: 700,
        minSpeechMs: 300,
        preSpeechPadMs: 250,
        getStream: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }),
        onFrameProcessed: (p: { isSpeech: number }) => {
          if (Math.abs(p.isSpeech - this.state.level) > 0.05) this.set({ level: p.isSpeech });
        },
        onSpeechStart: () => {
          // Barge-in: talking over Jarvis stops it.
          if (this.state.status === 'speaking') this.stopSpeaking();
          this.set({ status: 'hearing' });
        },
        onVADMisfire: () => this.set({ status: 'listening' }),
        onSpeechEnd: (audio: Float32Array) => void this.handleSpeech(audio),
      } as never);
      this.vad = vad as unknown as typeof this.vad;
      await this.vad!.start();
      this.set({ status: 'listening' });
    } catch (err) {
      const msg = (err as Error).name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it for Jarvis in the browser or system settings.' : (err as Error).message;
      this.set({ status: 'error', error: msg });
    }
  }

  async stop(): Promise<void> {
    this.setPrefs({ enabled: false });
    this.stopSpeaking();
    await this.vad?.destroy().catch(() => undefined);
    this.vad = null;
    this.release();
    this.set({ status: 'off', level: 0, awaiting: false });
  }

  setAwaiting(awaiting: boolean) {
    this.set({ awaiting });
  }

  private async handleSpeech(audio: Float32Array) {
    if (!this.stt) return;
    this.set({ status: 'thinking' });
    const id = this.nextId++;
    const text = await new Promise<string>((resolve) => {
      this.sttWait.set(id, resolve);
      this.stt!.postMessage({ type: 'transcribe', id, audio, language: this.state.prefs.language, model: this.state.prefs.sttModel }, [audio.buffer]);
    });
    this.set({ heard: text, status: this.state.status === 'thinking' ? 'listening' : this.state.status });
    if (text) this.onUtterance?.(text);
  }

  private enqueue(samples: Float32Array, rate: number, last: boolean, id: number) {
    const ctx = this.audio();
    const buf = ctx.createBuffer(1, samples.length, rate);
    buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.03, this.playhead);
    src.start(at);
    this.playhead = at + buf.duration;
    this.playing.push(src);
    this.set({ status: 'speaking' });
    src.onended = () => {
      this.playing = this.playing.filter((p) => p !== src);
      if (last && this.playing.length === 0 && id === this.speakId) {
        this.set({ status: this.vad ? 'listening' : 'idle' });
        this.speakDone.get(id)?.();
        this.speakDone.delete(id);
      }
    };
  }

  /** Speak text with Kokoro. Resolves when playback ends (or is interrupted). */
  speak(text: string): Promise<void> {
    const clean = text.trim();
    if (!clean) return Promise.resolve();
    // Never silent: the OS voice covers the first-ever download; after that Kokoro is used.
    if (this.state.prefs.engine === 'system') return this.speakSystem(clean);
    if (!this.ready.voice && (this.tts === null || this.loadingVoice())) {
      if (this.tts === null) {
        this.workers();
        this.tts!.postMessage({ type: 'load' });
      }
      return this.speakSystem(clean);
    }
    this.workers();
    this.stopSpeaking();
    const id = this.nextId++;
    this.speakId = id;
    this.set({ said: clean });
    return new Promise<void>((resolve) => {
      this.speakDone.set(id, resolve);
      this.tts!.postMessage({ type: 'speak', id, text: clean, voice: this.state.prefs.voice, speed: this.state.prefs.speed });
    });
  }

  private loadingVoice(): boolean {
    // Loading for real (downloading files), not just a warm cache that will be ready in a second.
    return Object.values(this.progressByFile.voice).some((p) => p < 100);
  }

  /** Lightweight path: the operating system's own voice via the Web Speech API. */
  private speakSystem(text: string): Promise<void> {
    const synth = typeof speechSynthesis === 'undefined' ? null : speechSynthesis;
    if (!synth) return Promise.resolve();
    this.stopSpeaking();
    const id = this.nextId++;
    this.speakId = id;
    this.set({ said: text });
    const voices = synth.getVoices();
    const lang = this.state.prefs.language === 'auto' ? 'en' : this.state.prefs.language;
    const pick =
      voices.find((v) => /natural|neural|premium|enhanced/i.test(v.name) && v.lang.startsWith(lang === 'en' ? 'en-GB' : lang)) ??
      voices.find((v) => /natural|neural|premium|enhanced/i.test(v.name) && v.lang.startsWith(lang)) ??
      voices.find((v) => v.lang.startsWith(lang === 'en' ? 'en-GB' : lang)) ??
      voices.find((v) => v.lang.startsWith(lang)) ??
      null;
    const parts = sentences(text);
    return new Promise<void>((resolve) => {
      this.speakDone.set(id, resolve);
      parts.forEach((part, i) => {
        const u = new SpeechSynthesisUtterance(part);
        if (pick) u.voice = pick;
        u.rate = this.state.prefs.speed;
        u.onstart = () => id === this.speakId && this.set({ status: 'speaking' });
        if (i === parts.length - 1) {
          u.onend = u.onerror = () => {
            if (id !== this.speakId) return;
            this.set({ status: this.vad ? 'listening' : 'idle' });
            this.speakDone.get(id)?.();
            this.speakDone.delete(id);
          };
        }
        synth.speak(u);
      });
    });
  }

  stopSpeaking() {
    this.tts?.postMessage({ type: 'cancel' });
    if (typeof speechSynthesis !== 'undefined' && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
    for (const p of this.playing) {
      try {
        p.stop();
      } catch {
        // already stopped
      }
    }
    this.playing = [];
    this.playhead = 0;
    const done = this.speakDone.get(this.speakId);
    this.speakDone.delete(this.speakId);
    this.speakId = -1;
    done?.();
    if (this.state.status === 'speaking') this.set({ status: this.vad ? 'listening' : 'idle' });
  }

  /** Exposed for tests: sentence chunking used by the worker. */
  chunks(text: string) {
    return sentences(text);
  }
}

export const voice = new VoiceEngine();

export function useVoice(): VoiceState {
  return useSyncExternalStore(voice.subscribe, () => voice.state);
}
