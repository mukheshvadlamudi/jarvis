import { useSyncExternalStore } from 'react';
import { isEcho, isNoise, parseUtterance } from './intents.ts';
import { sentences } from './speech.ts';
import { openMicrophone, resolveMic } from './microphone.ts';
import { modelLoadLabel } from './loading.ts';
import type { ModelLoad } from './loading.ts';

/** Per-device voice preferences (voice runs in this browser/app, so they live in localStorage). */
export interface VoicePrefs {
  enabled: boolean;
  micId: string;
  micSensitivity: 'normal' | 'high';
  noiseSuppression: boolean;
  keepLoaded: boolean;
  /** kokoro: natural neural voice on this device (~600 MB RAM while on). system: the OS voice (no extra RAM). */
  engine: 'kokoro' | 'system';
  voice: string;
  voiceChosen: boolean;
  voiceQuality: 'best' | 'light';
  speed: number;
  wakeWord: boolean;
  language: string;
  sttModel: 'whisper-base' | 'whisper-small' | 'whisper-tiny';
  speak: { approvals: boolean; finished: boolean; failed: boolean; notify: boolean; brief: boolean; confirmations: boolean };
}

export const DEFAULT_PREFS: VoicePrefs = {
  enabled: false,
  micId: '',
  micSensitivity: 'normal',
  noiseSuppression: true,
  keepLoaded: typeof navigator !== 'undefined' && 'gpu' in navigator,
  engine: 'kokoro',
  voice: 'af_heart',
  voiceChosen: false,
  voiceQuality: 'best',
  speed: 1,
  wakeWord: true,
  language: 'en',
  sttModel: 'whisper-base',
  speak: { approvals: true, finished: true, failed: true, notify: true, brief: true, confirmations: true },
};

export const VOICES: Array<{ id: string; label: string }> = [
  { id: 'af_heart', label: 'Heart \u00b7 American, most natural (recommended) \u00b7 A' },
  { id: 'af_bella', label: 'Bella \u00b7 American \u00b7 A-' },
  { id: 'bf_emma', label: 'Emma \u00b7 British \u00b7 B-' },
  { id: 'am_michael', label: 'Michael \u00b7 American \u00b7 C+' },
  { id: 'bm_george', label: 'George \u00b7 British \u00b7 C' },
  { id: 'bm_fable', label: 'Fable \u00b7 British \u00b7 C' },
  { id: 'bf_isabella', label: 'Isabella \u00b7 British \u00b7 C' },
  { id: 'bm_lewis', label: 'Lewis \u00b7 British \u00b7 D+' },
  { id: 'bm_daniel', label: 'Daniel \u00b7 British \u00b7 D' },
  { id: 'am_adam', label: 'Adam \u00b7 American \u00b7 F+' },
];

const KEY = 'jarvis.voice';

/** Rendered (and cached) as soon as Kokoro loads, so the quick replies play with no wait. */
const PHRASES = ['Yes?', 'On it.', 'Approved.', 'Rejected. The agent will skip it.', 'Cancelled.', 'Nothing is running.', 'Approval needed.', 'Say approve or reject.', 'Good morning.', 'Systems online.'];
export function loadPrefs(): VoicePrefs {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<VoicePrefs>;
    return { ...DEFAULT_PREFS, ...p, voice: p.voice === 'bm_george' && !p.voiceChosen ? 'af_heart' : p.voice ?? DEFAULT_PREFS.voice, speak: { ...DEFAULT_PREFS.speak, ...(p.speak ?? {}) } };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export type VoiceStatus = 'off' | 'loading' | 'idle' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'error';

export interface VoiceState {
  status: VoiceStatus;
  micLabel: string;
  micFallback: string;
  persisted: boolean | null;
  loads: Partial<Record<'voice' | 'ears', ModelLoad>>;
  prefs: VoicePrefs;
  progress: { voice: number; ears: number };
  device: string | null;
  natural: 'unloaded' | 'loading' | 'ready' | 'failed';
  naturalError: string | null;
  adapter: string;
  fallback: string;
  activeEngine: 'kokoro' | 'system' | null;
  outcome: string;
  ignored: boolean;
  heard: string;
  said: string;
  awaiting: boolean;
  level: number;
  error: string | null;
  needsGesture: boolean;
}

type Listener = () => void;

/** How long a transcription may take once Whisper is loaded, and while it is still downloading. */
export const STT_READY_MS = 20_000;
export const STT_LOADING_MS = 120_000;
const MAX_STT_RESTARTS = 3;
/** No audio from the natural voice for this long means its worker is stuck. */
export const TTS_CHUNK_MS = 45_000;
export const HELD_LINE_MS = 60_000;
const STALLED_STT = 'Speech recognition stalled, please say that again';

/**
 * Local voice engine: Kokoro TTS + Whisper STT in workers, Silero VAD on the mic.
 * Nothing leaves the device and nothing costs credits.
 */
class VoiceEngine {
  state: VoiceState = { status: 'off', micLabel: '', micFallback: '', persisted: null, loads: {}, prefs: loadPrefs(), progress: { voice: 0, ears: 0 }, device: null, natural: 'unloaded', naturalError: null, adapter: '', fallback: '', activeEngine: null, outcome: '', ignored: false, heard: '', said: '', awaiting: false, level: 0, error: null, needsGesture: false };
  private feedbackTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<Listener>();
  private tts: Worker | null = null;
  private stt: Worker | null = null;
  private ctx: AudioContext | null = null;
  private vad: { start: () => Promise<void>; pause: () => Promise<void>; destroy: () => Promise<void> } | null = null;
  private micGeneration = 0;
  private micQueue = Promise.resolve();
  private nextId = 1;
  private playing: AudioBufferSourceNode[] = [];
  private playhead = 0;
  private speakId = 0;
  /** The newest line asked for while the natural voice was still loading. */
  private held: { text: string; at: number; resolve: () => void } | null = null;
  private speakDone: Map<number, () => void> = new Map();
  /** Resolves a transcription: the text, or null when it was dropped (superseded, stalled, released). */
  private sttWait: Map<number, (t: string | null) => void> = new Map();
  private sttRestarts = 0;
  private speakTimer: ReturnType<typeof setTimeout> | null = null;
  /** The line Jarvis was saying when the current speech segment began ('' if it was quiet). */
  private segmentSaid = '';
  private ready = { voice: false, ears: false };
  onUseHeard: ((text: string) => Promise<void>) | null = null;
  onUtterance: ((text: string) => void) | null = null;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  private set(patch: Partial<VoiceState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  feedback(outcome: string, ignored = false, brief = false) {
    if (this.feedbackTimer) clearTimeout(this.feedbackTimer);
    this.set({ outcome, ignored });
    if (brief) this.feedbackTimer = setTimeout(() => this.set({ outcome: '', ignored: false }), 7000);
  }

  async useHeard() {
    const text = this.state.heard;
    if (!this.state.ignored || !text) return;
    this.feedback('Opening a conversation…');
    await this.onUseHeard?.(text);
  }

  retryVoice() {
    this.stopSpeaking();
    this.tts?.terminate();
    this.tts = null;
    this.ready.voice = false;
    this.set({ loads: { ...this.state.loads, voice: { status: 'loading', loaded: 0, total: 0 } }, natural: 'loading', naturalError: null, fallback: '', adapter: '', device: null, progress: { ...this.state.progress, voice: 0 } });
    this.workers();
    this.tts!.postMessage({ type: 'load', quality: this.state.prefs.voiceQuality });
  }

  setPrefs(patch: Partial<VoicePrefs>) {
    const micChanged = (['micId', 'micSensitivity', 'noiseSuppression'] as const).some((key) => patch[key] !== undefined && patch[key] !== this.state.prefs[key]);
    const sttChanged = patch.sttModel !== undefined && patch.sttModel !== this.state.prefs.sttModel;
    if (patch.engine && patch.engine !== this.state.prefs.engine) {
      this.stopSpeaking();
      if (patch.engine === 'system') {
        this.tts?.terminate();
        this.tts = null;
        this.ready.voice = false;
        this.set({ loads: { ...this.state.loads, voice: undefined }, progress: { ...this.state.progress, voice: 0 }, natural: 'unloaded', device: null, naturalError: null, fallback: '', adapter: '' });
      }
    }
    if (patch.voice !== undefined) patch = { ...patch, voiceChosen: true };
    const qualityChanged = patch.voiceQuality !== undefined && patch.voiceQuality !== this.state.prefs.voiceQuality;
    const prefs = { ...this.state.prefs, ...patch, speak: { ...this.state.prefs.speak, ...(patch.speak ?? {}) } };
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      // storage blocked
    }
    this.set({ prefs });
    if (micChanged && prefs.enabled) void this.restartMic();
    if (sttChanged && this.stt) {
      this.ready.ears = false;
      this.set({ loads: { ...this.state.loads, ears: { status: 'loading', loaded: 0, total: 0 } }, progress: { ...this.state.progress, ears: 0 } });
      this.stt.postMessage({ type: 'load', model: prefs.sttModel });
    }
    if (patch.keepLoaded === false && !prefs.enabled) this.release();
    if (qualityChanged || (patch.engine === 'kokoro' && this.state.prefs.enabled)) this.retryVoice();
    if ((patch.voice || patch.speed) && this.ready.voice) this.tts?.postMessage({ type: 'prewarm', phrases: PHRASES.slice(0, 4), voice: prefs.voice, speed: prefs.speed });
  }

  private onWorker = (e: MessageEvent) => {
    const m = e.data as { type: string; what?: 'voice' | 'ears'; load?: ModelLoad; id?: number; samples?: Float32Array; rate?: number; last?: boolean; text?: string; message?: string; device?: string; adapter?: string; fallback?: string };
    if (m.type === 'model-load' && m.what && m.load) {
      this.set({ loads: { ...this.state.loads, [m.what]: m.load } });
    } else if (m.type === 'diagnostic') {
      this.set({ adapter: m.adapter ?? this.state.adapter, fallback: m.fallback ?? this.state.fallback });
    } else if (m.type === 'ready' && m.what) {
      this.ready[m.what] = true;
      this.set({ loads: { ...this.state.loads, [m.what]: { status: 'ready', loaded: 0, total: 0 } } });
      if (m.what === 'voice') this.tts?.postMessage({ type: 'prewarm', phrases: PHRASES, voice: this.state.prefs.voice, speed: this.state.prefs.speed });
      this.set({ progress: { ...this.state.progress, [m.what]: 100 }, ...(m.what === 'voice' ? { device: m.device ?? null, natural: 'ready' as const, naturalError: null } : {}) });
      // Say what arrived while the voice was loading, if it is still recent.
      const held = this.held;
      this.held = null;
      if (m.what === 'voice' && held && Date.now() - held.at < 60_000) void this.speak(held.text).then(held.resolve);
      else held?.resolve();
    } else if (m.type === 'audio' && m.samples && m.id === this.speakId) {
      this.enqueue(m.samples, m.rate ?? 24000, !!m.last, m.id);
    } else if (m.type === 'text' && m.id !== undefined) {
      this.sttRestarts = 0;
      this.sttWait.get(m.id)?.(m.text ?? '');
    } else if (m.type === 'superseded' && m.id !== undefined) {
      this.sttWait.get(m.id)?.(null);
    } else if (m.type === 'error') {
      if (m.what) this.set({ loads: { ...this.state.loads, [m.what]: { status: 'failed', loaded: 0, total: 0 } } });
      if (m.what === 'voice') {
        this.ready.voice = false;
        this.set({ natural: 'failed', naturalError: m.message ?? 'Unknown loading error' });
        this.held?.resolve();
        this.held = null;
        if (m.id === this.speakId) {
          const done = this.speakDone.get(this.speakId);
          this.speakDone.delete(this.speakId);
          this.stopSpeaking();
          done?.();
        }
        return;
      }
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
      this.tts.onerror = (e) => this.onWorker({ data: { type: 'error', what: 'voice', message: e.message, id: this.speakId } } as MessageEvent);
    }
    if (!this.stt) {
      this.stt = new Worker(new URL('./stt.worker.ts', import.meta.url), { type: 'module' });
      this.stt.onmessage = this.onWorker;
      // A crash posts no request id, so drain every waiting request and start a fresh worker.
      this.stt.onerror = (e) => this.restartStt('Speech recognition crashed, please say that again', e?.message);
    }
  }

  private audio(): AudioContext {
    this.ctx ??= new AudioContext();
    return this.ctx;
  }

  /** Download/warm the models without starting the mic (Settings → "Download voice models"). */
  preload() {
    this.workers();
    if (this.state.prefs.engine === 'kokoro' && this.state.natural === 'unloaded') {
      this.set({ natural: 'loading', loads: { ...this.state.loads, voice: { status: 'loading', loaded: 0, total: 0 } } });
      this.tts!.postMessage({ type: 'load', quality: this.state.prefs.voiceQuality });
    }
    if (!this.ready.ears && this.state.loads.ears?.status !== 'loading') {
      this.set({ loads: { ...this.state.loads, ears: { status: 'loading', loaded: 0, total: 0 } } });
      this.stt!.postMessage({ type: 'load', model: this.state.prefs.sttModel });
    }
  }

  /** Free models when memory retention is disabled. */
  private release() {
    this.tts?.terminate();
    this.stt?.terminate();
    this.tts = null;
    this.stt = null;
    this.ready = { voice: false, ears: false };
    this.drainStt();
    this.set({ loads: {}, progress: { voice: 0, ears: 0 }, device: null, natural: 'unloaded', naturalError: null, activeEngine: null, adapter: '', fallback: '' });
  }

  /** Turn hands-free voice on. Browsers need one user gesture for audio; the desktop app doesn't. */
  async start(): Promise<void> {
    if (this.state.status !== 'off' && this.state.status !== 'error') return;
    this.setPrefs({ enabled: true });
    this.set({ status: 'loading', error: null });
    void this.requestPersistence();
    navigator.mediaDevices?.addEventListener?.('devicechange', this.devicesChanged);
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
      if (!this.state.prefs.enabled) return;
      this.preload();
      await this.restartMic();
    } catch (err) {
      const msg = (err as Error).name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it for Jarvis in the browser or system settings.' : (err as Error).message;
      this.set({ status: 'error', error: msg });
    }
  }

  setPersistenceStatus(persisted: boolean) { this.set({ persisted }); }

  async requestPersistence() {
    try { this.set({ persisted: await navigator.storage.persist() }); }
    catch { this.set({ persisted: false }); }
  }

  private devicesChanged = () => {
    void navigator.mediaDevices.enumerateDevices().then((devices) => {
      const { missing } = resolveMic(this.state.prefs.micId, devices);
      if (missing !== !!this.state.micFallback) void this.restartMic();
    }).catch(() => undefined);
  };

  private restartMic(): Promise<void> {
    const generation = ++this.micGeneration;
    this.micQueue = this.micQueue.catch(() => undefined).then(async () => {
      await this.vad?.destroy().catch(() => undefined);
      this.vad = null;
      if (generation !== this.micGeneration || !this.state.prefs.enabled) return;
      const prefs = this.state.prefs;
      this.set({ level: 0, micLabel: '' });
      try {
        const { MicVAD } = await import('@ricky0123/vad-web');
        const vad = await MicVAD.new({
          model: 'v5',
          baseAssetPath: '/voice-runtime/vad/',
          onnxWASMBasePath: '/voice-runtime/vad/',
          positiveSpeechThreshold: prefs.micSensitivity === 'high' ? 0.45 : 0.6,
          negativeSpeechThreshold: prefs.micSensitivity === 'high' ? 0.3 : 0.45,
          redemptionMs: 700,
          minSpeechMs: prefs.micSensitivity === 'high' ? 200 : 300,
          preSpeechPadMs: 250,
          startOnLoad: false,
          getStream: async () => {
            const { stream, missing } = await openMicrophone(prefs.micId, prefs.noiseSuppression);
            if (generation !== this.micGeneration) { stream.getTracks().forEach((t) => t.stop()); throw new Error('Microphone changed'); }
            this.set({ micLabel: stream.getAudioTracks()[0]?.label ?? '', micFallback: missing ? 'Selected microphone is unavailable · using system default' : '' });
            return stream;
          },
          onFrameProcessed: (p: { isSpeech: number }) => {
            if (Math.abs(p.isSpeech - this.state.level) > 0.05) this.set({ level: p.isSpeech });
          },
          onSpeechStart: () => {
            // Don't stop Jarvis yet: this may be its own voice from the speakers. handleSpeech decides.
            this.segmentSaid = this.speaking() ? this.state.said : '';
            this.feedback('');
            if (!this.segmentSaid) this.set({ status: 'hearing' });
          },
          onVADMisfire: () => {
            this.set({ status: 'listening', heard: '' });
            this.feedback('Too short, try again', false, true);
          },
          onSpeechEnd: (audio: Float32Array) => void this.handleSpeech(audio),
        });
        if (generation !== this.micGeneration) { await vad.destroy(); return; }
        this.vad = vad;
        await this.vad!.start();
        if (generation !== this.micGeneration) { await vad.destroy(); return; }
        this.set({ status: 'listening' });
      } catch (err) {
        if (generation === this.micGeneration) this.set({ status: 'error', error: (err as Error).name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it for Jarvis in the browser or system settings.' : (err as Error).message });
      }
    });
    return this.micQueue;
  }

  async stop(): Promise<void> {
    this.setPrefs({ enabled: false });
    ++this.micGeneration;
    navigator.mediaDevices?.removeEventListener?.('devicechange', this.devicesChanged);
    this.stopSpeaking();
    await this.vad?.destroy().catch(() => undefined);
    this.vad = null;
    if (!this.state.prefs.keepLoaded) this.release();
    this.feedback('');
    this.set({ status: 'off', level: 0, awaiting: false, micLabel: '', micFallback: '' });
  }

  setAwaiting(awaiting: boolean) {
    this.set({ awaiting });
  }

  private speaking(): boolean {
    return this.speakDone.has(this.speakId);
  }

  private async handleSpeech(audio: Float32Array) {
    const echoOf = this.segmentSaid;
    this.segmentSaid = '';
    if (!this.stt) return;
    const generation = this.micGeneration;
    if (!echoOf) {
      this.feedback('Transcribing…');
      this.set({ status: 'thinking', heard: '…' });
    }
    const text = await this.transcribe(audio);
    if (this.state.status === 'off' || generation !== this.micGeneration) return;
    if (this.state.status === 'thinking') this.set({ status: 'listening' });
    if (text === null) return;
    if (echoOf && isEcho(text, echoOf)) return;
    this.set({ heard: text });
    if (isNoise(text)) {
      if (!echoOf) this.feedback('Not sure what you meant', false, true);
      return;
    }
    // Barge-in: a real command (not noise, not Jarvis's own voice) stops Jarvis mid-line.
    if (this.speaking() && parseUtterance(text, { requireWake: this.state.prefs.wakeWord, awaiting: this.state.awaiting }).kind !== 'ignore') this.stopSpeaking();
    this.onUtterance?.(text);
  }

  /** Send audio to Whisper with a deadline, so one stuck run can't stall the voice loop. */
  private transcribe(audio: Float32Array): Promise<string | null> {
    const id = this.nextId++;
    const loaded = this.ready.ears;
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.sttWait.has(id)) return;
        if (loaded && this.ready.ears) return this.restartStt(STALLED_STT);
        // Still downloading: drop this request but don't restart, which would restart the download.
        this.sttWait.get(id)?.(null);
        this.feedback('Speech model is still loading · try again in a moment', false, true);
      }, loaded ? STT_READY_MS : STT_LOADING_MS);
      this.sttWait.set(id, (t) => {
        clearTimeout(timer);
        this.sttWait.delete(id);
        resolve(t);
      });
      this.stt!.postMessage({ type: 'transcribe', id, audio, language: this.state.prefs.language, model: this.state.prefs.sttModel }, [audio.buffer]);
    });
  }

  private drainStt() {
    for (const r of [...this.sttWait.values()]) r(null);
    this.sttWait.clear();
  }

  /** Replace a stuck or crashed Whisper worker; give up after a few tries. */
  private restartStt(message: string, detail?: string) {
    this.drainStt();
    this.stt?.terminate();
    this.stt = null;
    this.ready.ears = false;
    if (this.state.status === 'thinking' || this.state.status === 'hearing') this.set({ status: this.vad ? 'listening' : 'idle' });
    if (++this.sttRestarts > MAX_STT_RESTARTS) {
      this.set({ status: 'error', error: 'Speech recognition keeps failing' + (detail ? ': ' + detail : '') + '. Turn voice off and on again, or pick a smaller model in Settings → Voice.', loads: { ...this.state.loads, ears: { status: 'failed', loaded: 0, total: 0 } } });
      return;
    }
    this.workers();
    this.set({ loads: { ...this.state.loads, ears: { status: 'loading', loaded: 0, total: 0 } }, progress: { ...this.state.progress, ears: 0 } });
    this.stt!.postMessage({ type: 'load', model: this.state.prefs.sttModel });
    void this.speak(message);
    this.feedback(message, false, true);
  }

  private clearSpeakTimer() {
    if (this.speakTimer) clearTimeout(this.speakTimer);
    this.speakTimer = null;
  }

  /** If the natural voice sends no audio for a while, its worker is stuck: stop and reload it. */
  private armVoiceWatchdog(id: number) {
    this.clearSpeakTimer();
    this.speakTimer = setTimeout(() => {
      if (id !== this.speakId) return;
      this.stopSpeaking();
      this.retryVoice();
    }, TTS_CHUNK_MS);
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
    this.set({ status: 'speaking', activeEngine: 'kokoro' });
    if (!last) this.armVoiceWatchdog(id);
    else {
      // onended can go missing (suspended context, device change): resolve after playback + 3 s anyway.
      this.clearSpeakTimer();
      this.speakTimer = setTimeout(() => id === this.speakId && this.stopSpeaking(), Math.max(0, this.playhead - ctx.currentTime) * 1000 + 3000);
    }
    src.onended = () => {
      this.playing = this.playing.filter((p) => p !== src);
      if (last && this.playing.length === 0 && id === this.speakId) {
        this.clearSpeakTimer();
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
    // System speech is used only when explicitly selected.
    if (this.state.prefs.engine === 'system') return this.speakSystem(clean);
    if (!this.ready.voice) {
      if (this.state.natural === 'unloaded') this.preload();
      if (this.state.natural === 'failed') {
        this.feedback('Natural voice failed to load · retry in Settings → Voice');
        return Promise.resolve();
      }
      // Hold the newest line and say it the moment the natural voice is ready (no robotic stand-in).
      this.held?.resolve();
      this.feedback('Natural voice is loading · Jarvis will say this when it is ready');
      return new Promise<void>((resolve) => {
        const held = { text: clean, at: Date.now(), resolve };
        this.held = held;
        // Don't keep the caller waiting forever if the voice never becomes ready.
        setTimeout(() => {
          if (this.held !== held) return;
          this.held = null;
          resolve();
        }, HELD_LINE_MS);
      });
    }
    this.workers();
    this.stopSpeaking();
    const id = this.nextId++;
    this.speakId = id;
    this.set({ said: clean, activeEngine: 'kokoro' });
    return new Promise<void>((resolve) => {
      this.speakDone.set(id, resolve);
      this.armVoiceWatchdog(id);
      this.tts!.postMessage({ type: 'speak', id, text: clean, voice: this.state.prefs.voice, speed: this.state.prefs.speed });
    });
  }

  /** Lightweight path: the operating system's own voice via the Web Speech API. */
  private speakSystem(text: string): Promise<void> {
    const synth = typeof speechSynthesis === 'undefined' ? null : speechSynthesis;
    if (!synth) return Promise.resolve();
    this.stopSpeaking();
    const id = this.nextId++;
    this.speakId = id;
    this.set({ said: text, activeEngine: 'system' });
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
            this.clearSpeakTimer();
            this.set({ status: this.vad ? 'listening' : 'idle' });
            this.speakDone.get(id)?.();
            this.speakDone.delete(id);
          };
        }
        synth.speak(u);
      });
      // Chrome sometimes never fires onend: cap the wait by an estimate of the speaking time.
      this.clearSpeakTimer();
      this.speakTimer = setTimeout(() => id === this.speakId && this.stopSpeaking(), systemSpeechMs(text, this.state.prefs.speed));
    });
  }

  stopSpeaking() {
    this.clearSpeakTimer();
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

/** Upper bound for an OS-voice line: about 14 characters a second at speed 1, plus 5 s slack. */
export function systemSpeechMs(text: string, speed: number): number {
  return Math.round((text.length / 14 / Math.max(0.5, speed)) * 1000) + 5000;
}

export const voice = new VoiceEngine();

export function useVoice(): VoiceState {
  return useSyncExternalStore(voice.subscribe, () => voice.state);
}

/** Shared wording keeps the dock and Settings honest about the actual speaker. */
export function voiceEngineStatus(v: VoiceState): string {
  const device = v.device === 'webgpu' ? 'Graphics card (WebGPU)' : 'CPU (WASM)';
  const system = v.status === 'speaking' ? v.activeEngine === 'system' : v.prefs.engine === 'system' || v.natural !== 'ready';
  let label = system && v.prefs.engine === 'system' ? 'System voice' : 'Natural voice';
  if (v.prefs.engine === 'kokoro') {
    if (v.natural === 'failed') label += ' \u00b7 natural voice failed to load: ' + v.naturalError;
    else if (v.natural === 'loading') label += ' \u00b7 ' + (modelLoadLabel('voice', v.loads.voice) || 'Loading voice');
    else if (v.natural === 'ready') label += system ? ' \u00b7 natural voice ready on ' + device : ' \u00b7 ' + device;
    else label += ' \u00b7 loads when voice turns on';
  }
  return label;
}
