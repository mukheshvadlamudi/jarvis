import { useSyncExternalStore } from 'react';
import { isEcho, isNoise, parseUtterance } from './intents.ts';
import { turnComplete } from './turn.ts';
import type { VoiceToken } from './turn.ts';
import { sentences } from './speech.ts';
import { openMicrophone, resolveMic } from './microphone.ts';
import { modelLoadLabel } from './loading.ts';
import type { ModelLoad } from './loading.ts';

/** Per-device voice preferences (voice runs in this browser/app, so they live in localStorage). */
export interface VoicePrefs {
  enabled: boolean;
  interruptions: 'speaker-safe' | 'headset';
  turnDetection: 'smart' | 'simple';
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
  interruptions: 'speaker-safe',
  turnDetection: 'smart',
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
  muted: boolean;
  turnStatus: string;
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
  state: VoiceState = { status: 'off', muted: false, turnStatus: 'Smart Turn loads on first turn', micLabel: '', micFallback: '', persisted: null, loads: {}, prefs: loadPrefs(), progress: { voice: 0, ears: 0 }, device: null, natural: 'unloaded', naturalError: null, adapter: '', fallback: '', activeEngine: null, outcome: '', ignored: false, heard: '', said: '', awaiting: false, level: 0, error: null, needsGesture: false };
  speechEpoch = 0;
  private turnId = 0;
  private generations = { voice: 0, ears: 0, turn: 0 };
  private gain: GainNode | null = null;
  private onset: number | null = null;
  private ducked = false;
  private segmentHuman = false;
  private paused = false;
  private ttsRendering = false;
  private segmentFrames: Float32Array[] = [];
  private segmentSamples = 0;
  private segmentCapped = false;
  private cancelId = 0;
  private cancelTimer: ReturnType<typeof setTimeout> | null = null;
  private sttStarted = new Map<number, () => void>();
  private turnWorker: Worker | null = null;
  private turnAudio: Float32Array = new Float32Array();
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private turnStarted = 0;
  private decisionId = 0;
  private smartFailed = false;
  onStopSpeaking: (() => void) | null = null;
  onStopAgent: (() => void) | null = null;
  onTurnStart: (() => void) | null = null;
  private token(generation: number): VoiceToken { return { turnId: this.turnId, speechEpoch: this.speechEpoch, generation }; }
  private current(token: VoiceToken): boolean { return token.turnId === this.turnId && token.speechEpoch === this.speechEpoch; }
  private outputGain(value: number) { this.gain?.gain.setTargetAtTime(value, this.ctx?.currentTime ?? 0, 0.02); }
  private resumeOutput() {
    if (!this.paused) return;
    this.paused = false; void this.ctx?.resume?.();
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.resume?.();
  }
  muteMic() {
    this.set({ muted: !this.state.muted, level: 0, awaiting: false, status: this.speaking() ? 'speaking' : this.vad ? 'listening' : 'idle' });
    ++this.turnId; this.resetTurn(); this.drainStt();
  }
  private resetTurn() {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null; this.turnAudio = new Float32Array();
    ++this.decisionId; this.turnStarted = 0;
    this.segmentFrames = []; this.segmentSamples = 0;
  }
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
  private held: { text: string; at: number; token: VoiceToken; resolve: () => void } | null = null;
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
    this.send(this.tts!, { type: 'load', quality: this.state.prefs.voiceQuality });
  }

  setPrefs(patch: Partial<VoicePrefs>) {
    const micChanged = (['micId', 'micSensitivity', 'noiseSuppression', 'turnDetection', 'interruptions'] as const).some((key) => patch[key] !== undefined && patch[key] !== this.state.prefs[key]);
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
    if (patch.turnDetection) { this.smartFailed = false; this.resetTurn(); }
    if (micChanged && prefs.enabled) void this.restartMic();
    if (sttChanged && this.stt) {
      this.ready.ears = false;
      this.set({ loads: { ...this.state.loads, ears: { status: 'loading', loaded: 0, total: 0 } }, progress: { ...this.state.progress, ears: 0 } });
      this.drainStt(); this.send(this.stt, { type: 'load', model: prefs.sttModel });
    }
    if (patch.keepLoaded === false && !prefs.enabled) this.release();
    if (qualityChanged || (patch.engine === 'kokoro' && this.state.prefs.enabled)) this.retryVoice();
    if ((patch.voice || patch.speed) && this.ready.voice) this.tts && this.send(this.tts, { type: 'prewarm', phrases: PHRASES.slice(0, 4), voice: prefs.voice, speed: prefs.speed });
  }

  private onWorker = (e: MessageEvent) => {
    const m = e.data as { type: string; what?: 'voice' | 'ears'; load?: ModelLoad; id?: number; samples?: Float32Array; rate?: number; last?: boolean; text?: string; message?: string; device?: string; adapter?: string; fallback?: string; cancelId?: number };
    if (m.type === 'rendering' || m.type === 'rendered') {
      this.ttsRendering = m.type === 'rendering';
    } else if (m.type === 'cancelled' && (m.cancelId === undefined || m.cancelId === this.cancelId)) {
      if (this.cancelTimer) clearTimeout(this.cancelTimer);
      this.cancelTimer = null;
    } else if (m.type === 'started' && m.id !== undefined) {
      this.sttStarted.get(m.id)?.();
    } else if (m.type === 'model-load' && m.what && m.load) {
      this.set({ loads: { ...this.state.loads, [m.what]: m.load } });
    } else if (m.type === 'diagnostic') {
      this.set({ adapter: m.adapter ?? this.state.adapter, fallback: m.fallback ?? this.state.fallback });
    } else if (m.type === 'ready' && m.what) {
      this.ready[m.what] = true;
      if (m.what === 'ears') for (const arm of this.sttStarted.values()) arm();
      this.set({ loads: { ...this.state.loads, [m.what]: { status: 'ready', loaded: 0, total: 0 } } });
      if (m.what === 'voice') this.tts && this.send(this.tts, { type: 'prewarm', phrases: PHRASES, voice: this.state.prefs.voice, speed: this.state.prefs.speed });
      this.set({ progress: { ...this.state.progress, [m.what]: 100 }, ...(m.what === 'voice' ? { device: m.device ?? null, natural: 'ready' as const, naturalError: null } : {}) });
      if (m.what === 'voice') {
        const held = this.held;
        this.held = null;
        if (held && this.current(held.token) && Date.now() - held.at < HELD_LINE_MS) void this.speak(held.text).then(held.resolve);
        else held?.resolve();
      }
    } else if (m.type === 'audio' && m.samples && m.id === this.speakId) {
      this.enqueue(m.samples, m.rate ?? 24000, !!m.last, m.id);
    } else if (m.type === 'text' && m.id !== undefined) {
      this.sttRestarts = 0;
      this.sttWait.get(m.id)?.(m.text ?? '');
    } else if (m.type === 'superseded' && m.id !== undefined) {
      this.sttWait.get(m.id)?.(null);
    } else if (m.type === 'error') {
      if (m.what === 'voice' && m.id != null && m.id !== this.speakId) return;
      if (m.what === 'ears' && (m.id === undefined || m.id === null)) this.drainStt();
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
      this.ttsRendering = false;
      this.tts = new Worker(new URL('./tts.worker.ts', import.meta.url), { type: 'module' });
      this.bindWorker(this.tts, 'voice');
      const worker = this.tts;
      worker.onerror = (e) => { if (worker === this.tts) this.onWorker({ data: { type: 'error', what: 'voice', message: e.message, id: this.speakId } } as MessageEvent); };
    }
    if (!this.stt) {
      this.stt = new Worker(new URL('./stt.worker.ts', import.meta.url), { type: 'module' });
      this.bindWorker(this.stt, 'ears');
      // A crash posts no request id, so drain every waiting request and start a fresh worker.
      const worker = this.stt;
      worker.onerror = (e) => { if (worker === this.stt) this.restartStt('Speech recognition crashed, please say that again', e?.message); };
    }
  }

  private bindWorker(worker: Worker, what: 'voice' | 'ears') {
    const generation = ++this.generations[what];
    worker.onmessage = (event) => {
      if (this.generations[what] !== generation || (what === 'voice' ? this.tts : this.stt) !== worker) return;
      const m = event.data;
      if (m.generation !== undefined && m.generation !== generation) return;
      if (m.type === 'audio' && m.speechEpoch !== undefined && m.speechEpoch !== this.speechEpoch) return;
      this.onWorker(event);
    };
  }
  private send(worker: Worker, message: object, transfer?: Transferable[]) {
    const generation = worker === this.tts ? this.generations.voice : this.generations.ears;
    worker.postMessage({ ...message, ...this.token(generation) }, transfer ?? []);
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
      this.send(this.tts!, { type: 'load', quality: this.state.prefs.voiceQuality });
    }
    if (!this.ready.ears && this.state.loads.ears?.status !== 'loading') {
      this.set({ loads: { ...this.state.loads, ears: { status: 'loading', loaded: 0, total: 0 } } });
      this.send(this.stt!, { type: 'load', model: this.state.prefs.sttModel });
    }
  }

  /** Free models when memory retention is disabled. */
  private release() {
    if (this.cancelTimer) clearTimeout(this.cancelTimer); this.cancelTimer = null;
    this.tts?.terminate();
    this.stt?.terminate();
    this.tts = null;
    this.stt = null;
    this.turnWorker?.terminate(); this.turnWorker = null; ++this.generations.turn; this.resetTurn();
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
          redemptionMs: prefs.turnDetection === 'smart' && !this.smartFailed ? 300 : 700,
          minSpeechMs: prefs.micSensitivity === 'high' ? 200 : 300,
          preSpeechPadMs: 250,
          startOnLoad: false,
          getStream: async () => {
            const { stream, missing } = await openMicrophone(prefs.micId, prefs.noiseSuppression);
            if (generation !== this.micGeneration) { stream.getTracks().forEach((t) => t.stop()); throw new Error('Microphone changed'); }
            this.set({ micLabel: stream.getAudioTracks()[0]?.label ?? '', micFallback: missing ? 'Selected microphone is unavailable · using system default' : '' });
            return stream;
          },
          onFrameProcessed: (p: { isSpeech: number }, frame?: Float32Array) => {
            if (this.state.muted || (this.speaking() && this.state.prefs.interruptions === 'speaker-safe')) return;
            if (frame && this.turnStarted && !this.segmentCapped) {
              const remaining = Math.max(0, 480000 - this.turnAudio.length - this.segmentSamples);
              const chunk = frame.slice(0, remaining);
              this.segmentFrames.push(chunk); this.segmentSamples += chunk.length;
              if (!remaining || this.segmentSamples + this.turnAudio.length >= 480000) {
                const audio = new Float32Array(this.segmentSamples);
                let offset = 0;
                for (const part of this.segmentFrames) { audio.set(part, offset); offset += part.length; }
                this.segmentCapped = true;
                void this.endpoint(audio);
              }
            }
            if (this.speaking() && this.state.prefs.interruptions === 'headset') {
              if (p.isSpeech >= 0.6) {
                this.onset ??= Date.now();
                if (Date.now() - this.onset >= 160 && !this.ducked) { this.segmentHuman = true; this.ducked = true; this.outputGain(0.15); }
                if (Date.now() - this.onset >= 200 && p.isSpeech >= 0.8 && !this.paused) { this.paused = true; void this.ctx?.suspend?.(); if (typeof speechSynthesis !== 'undefined') speechSynthesis.pause?.(); }
              } else { this.onset = null; if (this.ducked && !this.segmentHuman) { this.ducked = false; this.outputGain(1); this.resumeOutput(); } }
            }
            if (Math.abs(p.isSpeech - this.state.level) > 0.05) this.set({ level: p.isSpeech });
          },
          onSpeechStart: () => {
            if (this.state.muted || (this.speaking() && this.state.prefs.interruptions === 'speaker-safe')) return;
            if (!this.turnAudio.length) { ++this.turnId; this.turnStarted = Date.now(); this.onTurnStart?.(); }
            this.segmentHuman = false;
            this.segmentFrames = []; this.segmentSamples = 0; this.segmentCapped = false;
            if (this.turnTimer) clearTimeout(this.turnTimer);
            ++this.decisionId;
            this.segmentSaid = this.speaking() ? this.state.said : '';
            this.feedback('');
            if (!this.segmentSaid) this.set({ status: 'hearing' });
          },
          onVADMisfire: () => {
            this.segmentHuman = false;
            this.ducked = false; this.onset = null; this.outputGain(1); this.resumeOutput();
            if (this.speaking()) return;
            if (this.turnAudio.length) { void this.endpoint(new Float32Array()); return; }
            this.set({ status: 'listening', heard: '' });
            this.feedback('Too short, try again', false, true);
          },
          onSpeechEnd: (audio: Float32Array) => {
            this.segmentFrames = []; this.segmentSamples = 0;
            if (this.segmentCapped) { this.segmentCapped = false; return; }
            void this.endpoint(audio);
          },
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

  private async endpoint(audio: Float32Array) {
    if (this.state.muted || (this.speaking() && this.state.prefs.interruptions === 'speaker-safe')) return;
    if (this.state.prefs.turnDetection === 'simple') return this.handleSpeech(audio);
    const remaining = Math.max(0, 480000 - this.turnAudio.length);
    const combined = new Float32Array(this.turnAudio.length + Math.min(remaining, audio.length));
    combined.set(this.turnAudio); combined.set(audio.subarray(0, remaining), this.turnAudio.length);
    this.turnAudio = combined;
    const token = this.token(this.generations.turn);
    const id = ++this.decisionId;
    const commit = () => {
      if (id !== this.decisionId || !this.current(token)) return;
      const full = this.turnAudio; this.resetTurn(); void this.handleSpeech(full);
    };
    this.turnTimer = setTimeout(commit, this.smartFailed ? 400 : 1700);
    if (combined.length >= 480000) return commit();
    if (this.smartFailed) return;
    if (!this.turnWorker) {
      this.turnWorker = new Worker(new URL('./turn.worker.ts', import.meta.url), { type: 'module' });
      ++this.generations.turn;
    }
    const generation = this.generations.turn;
    const fail = () => {
      if (generation !== this.generations.turn) return;
      this.smartFailed = true; this.set({ turnStatus: 'Simple timing - Smart Turn unavailable' });
      this.turnWorker?.terminate(); this.turnWorker = null; ++this.generations.turn;
      if (id === this.decisionId && this.current(token)) { if (this.turnTimer) clearTimeout(this.turnTimer); this.turnTimer = setTimeout(commit, 400); }
    };
    this.turnWorker.onerror = fail;
    this.turnWorker.onmessage = (event) => {
      const m = event.data;
      if (generation !== this.generations.turn) return;
      if (m.type === 'error') return fail();
      this.set({ turnStatus: 'Smart Turn ready - on this device' });
      if (m.id !== this.decisionId || !this.current(m)) return;
      if (turnComplete(m.probability, 300, Math.max(combined.length / 16, Date.now() - this.turnStarted))) commit();
      else this.set({ status: 'hearing' });
    };
    this.turnWorker.postMessage({ ...this.token(generation), id, audio: combined.slice(-128000) });
  }
  private async handleSpeech(audio: Float32Array) {
    const echoOf = this.segmentSaid;
    this.segmentSaid = '';
    if (!this.stt) return;
    const generation = this.micGeneration;
    const token = this.token(this.generations.ears);
    if (!echoOf) {
      this.feedback('Transcribing…');
      this.set({ status: 'thinking', heard: '…' });
    }
    const text = await this.transcribe(audio);
    if (this.state.status === 'off' || this.state.muted || generation !== this.micGeneration || !this.current(token)) return;
    if (this.state.status === 'thinking') this.set({ status: 'listening' });
    if (text === null) return;
    const weakOnset = !this.segmentHuman;
    this.segmentHuman = false;
    this.ducked = false; this.onset = null; this.outputGain(1);
    if (echoOf && this.speaking() && weakOnset && isEcho(text, echoOf)) return;
    this.set({ heard: text });
    if (isNoise(text)) {
      if (!echoOf) this.feedback('Not sure what you meant', false, true);
      return;
    }
    // Barge-in: a real command (not noise, not Jarvis's own voice) stops Jarvis mid-line.
    if (this.speaking() && parseUtterance(text, { requireWake: this.state.prefs.wakeWord, awaiting: this.state.awaiting }).kind !== 'ignore') this.stopSpeaking(false);
    this.onUtterance?.(text);
  }

  /** Send audio to Whisper with a deadline, so one stuck run can't stall the voice loop. */
  private transcribe(audio: Float32Array): Promise<string | null> {
    const id = this.nextId++;
    const token = this.token(this.generations.ears);
    return new Promise<string | null>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const arm = () => { clearTimeout(timer); timer = setTimeout(() => this.sttWait.has(id) && this.restartStt(STALLED_STT), STT_READY_MS); };
      timer = setTimeout(() => {
        this.sttWait.get(id)?.(null);
        this.feedback('Speech model is still loading ? try again in a moment', false, true);
      }, STT_LOADING_MS);
      this.sttStarted.set(id, arm);
      if (this.ready.ears) arm();
      this.sttWait.set(id, (t) => {
        clearTimeout(timer); this.sttStarted.delete(id); this.sttWait.delete(id);
        resolve(this.current(token) ? t : null);
      });
      this.send(this.stt!, { type: 'transcribe', id, audio, language: this.state.prefs.language, model: this.state.prefs.sttModel }, [audio.buffer]);
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
    this.send(this.stt!, { type: 'load', model: this.state.prefs.sttModel });
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
    this.gain ??= ctx.createGain?.() ?? null;
    if (this.gain) { this.gain.connect(ctx.destination); src.connect(this.gain); } else src.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.03, this.playhead);
    src.start(at);
    this.playhead = at + buf.duration + 0.12;
    this.playing.push(src);
    this.set({ status: 'speaking', activeEngine: 'kokoro' });
    if (!last) this.armVoiceWatchdog(id);
    else {
      // onended can go missing (suspended context, device change): resolve after playback + 3 s anyway.
      this.clearSpeakTimer();
      this.speakTimer = setTimeout(() => id === this.speakId && this.stopSpeaking(false), Math.max(0, this.playhead - ctx.currentTime) * 1000 + 3000);
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
        const held = { text: clean, at: Date.now(), token: this.token(this.generations.voice), resolve };
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
    this.stopSpeaking(false);
    const id = this.nextId++;
    this.speakId = id;
    this.set({ said: clean, activeEngine: 'kokoro', status: 'speaking' });
    return new Promise<void>((resolve) => {
      this.speakDone.set(id, resolve);
      this.armVoiceWatchdog(id);
      this.send(this.tts!, { type: 'speak', id, text: clean, voice: this.state.prefs.voice, speed: this.state.prefs.speed });
    });
  }

  /** Lightweight path: the operating system's own voice via the Web Speech API. */
  private speakSystem(text: string): Promise<void> {
    const synth = typeof speechSynthesis === 'undefined' ? null : speechSynthesis;
    if (!synth) return Promise.resolve();
    this.stopSpeaking(false);
    const id = this.nextId++;
    this.speakId = id;
    this.set({ said: text, activeEngine: 'system', status: 'speaking' });
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

  stopSpeaking(invalidate = true) {
    if (invalidate) {
      ++this.speechEpoch; ++this.turnId; this.resetTurn(); this.drainStt();
      this.held?.resolve(); this.held = null; this.onStopSpeaking?.();
      if (this.state.status === 'hearing' || this.state.status === 'thinking') this.set({ status: this.vad ? 'listening' : 'idle' });
      if (this.state.prefs.enabled) this.setAwaiting(true);
    }
    this.ducked = false; this.onset = null; this.outputGain(1);
    this.clearSpeakTimer();
    const worker = this.tts;
    if ((this.speaking() || this.ttsRendering) && worker && !this.cancelTimer) {
      this.cancelTimer = setTimeout(() => {
        this.cancelTimer = null;
        if (this.tts !== worker) return;
        worker.terminate(); this.tts = null; this.ready.voice = false;
        const said = this.state.said;
        const done = this.speakDone.get(this.speakId);
        this.speakDone.delete(this.speakId);
        this.set({ natural: 'unloaded' }); this.preload();
        if (done) void this.speak(said).then(done);
      }, 500);
    }
    this.tts && this.send(this.tts, { type: 'cancel', cancelId: ++this.cancelId });
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
