import { useSyncExternalStore } from 'react';
import { FunctionResponseScheduling } from '@google/genai';
import type { FunctionResponse, LiveServerMessage } from '@google/genai';
import { api, post } from '../../lib/api.ts';
import { subscribeLive } from '../../lib/live.ts';
import { navigate } from '../../lib/router.ts';
import { voice } from '../engine.ts';
import { openMicrophone } from '../microphone.ts';
import { base64, CAPTURE_WORKLET, decodePcm, PcmEncoder, PlaybackQueue, rms, SpeechGate } from './audio.ts';
import { LiveClient, quotaFailure } from './client.ts';
import { LocalTurn, SentenceStream } from './local-turn.ts';
import { plainAnswer, VoiceTools } from './tools.ts';
import type { AgentRun } from './tools.ts';

type State = 'off' | 'connecting' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'working' | 'error';
export interface VoiceSessionState {
  status: State; connection: string; brain: 'gemini' | 'local'; model: string; configured: boolean | null;
  fullView: boolean; conversationId: string | null; muted: boolean; input: string; output: string;
  lines: Array<{ user: string; assistant: string }>; notice: string; error: string;
  liveVoice: string; runs: AgentRun[]; inSec: number; outSec: number;
  pendingInSec: number; pendingOutSec: number;
}
function saved(key: string, fallback: string) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
export function rememberSetting(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* Private storage. */ } }

class VoiceSessionStore {
  state: VoiceSessionState = {
    status: 'off', connection: 'Disconnected', brain: saved('jarvis.voice.brain', 'gemini') === 'local' ? 'local' : 'gemini', model: '', configured: null,
    fullView: false, conversationId: null, muted: false, input: '', output: '', lines: [], notice: '', error: '',
    liveVoice: saved('jarvis.voice.live.voice', 'Puck'), runs: [], inSec: 0, outSec: 0,
    pendingInSec: 0, pendingOutSec: 0,
  };
  micLevel = 0; outputLevel = 0;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  set(patch: Partial<VoiceSessionState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach((l) => l()); }
  private client: LiveClient | null = null;
  private playback: PlaybackQueue | null = null;
  private ctx: AudioContext | null = null;
  private vad: { destroy: () => Promise<void> } | null = null;
  private stream: MediaStream | null = null;
  private worklet: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private gate: SpeechGate | null = null;
  private tools: VoiceTools | null = null;
  private toolCalls = new Map<string, AbortController>();
  private pendingResponses: FunctionResponse[] = [];
  private local: LocalTurn | null = null;
  private localRestore: (() => void) | null = null;
  private localUnsub: (() => void) | null = null;
  private events: (() => void) | null = null;
  private interval: ReturnType<typeof setInterval> | undefined;
  private lastSpeech = 0;
  private idleEnding = false;
  private generation = 0;
  private usage = { inSec: 0, outSec: 0 };
  private usageAt = 0;
  private usageBusy = false;
  private pushHeld = false;
  private speechQueue = Promise.resolve();
  private speechEpoch = 0;
  private transcriptQueue = Promise.resolve();
  private localAnswers = new Map<string, { text: string; stream: SentenceStream; started: boolean }>();
  private localRunId: string | null = null;
  private localCancelled = new Set<string>();

  async configure() {
    try {
      const info = await api<{ configured: boolean; model: string | null; error?: string }>('/api/voice/live');
      this.set({ configured: info.configured, model: this.state.status === 'off' ? info.model ?? '' : this.state.model, ...(info.error ? { notice: info.error } : {}) });
      if (!info.configured && this.state.status === 'off') this.set({ brain: 'local' });
      await this.loadUsage();
    } catch (error) { this.set({ notice: (error as Error).message, configured: false, brain: 'local' }); }
  }
  async loadUsage() {
    try { const totals = await api<{ inSec: number; outSec: number }>('/api/voice/live/usage'); this.set(totals); }
    catch { /* A failed meter never prevents talking. */ }
  }
  setConversation(id: string | null) {
    if (this.state.status !== 'off' && this.state.conversationId && id !== this.state.conversationId) return;
    this.set({ conversationId: id }); if (this.tools) this.tools.conversationId = id;
  }
  private changed = (id: string) => {
    this.set({ conversationId: id });
    if (this.state.fullView) navigate(`/c/${id}`);
  };
  async start(id = this.state.conversationId) {
    if (!['off', 'error'].includes(this.state.status)) return;
    const generation = ++this.generation;
    const background = voice.state.prefs.enabled && !voice.focusedSession && !['off', 'error'].includes(voice.state.status);
    if (background) this.set({ brain: 'local' });
    this.set({ status: 'connecting', error: '', conversationId: id, muted: false, connection: 'Connecting' });
    voice.setFocusedSession(true);
    if (!background) await voice.stop();
    if (generation !== this.generation) return;
    this.tools = new VoiceTools(id, this.changed);
    void this.refreshRuns();
    this.events = subscribeLive((e) => {
      if ((e.type === 'hello' || e.type === 'reconcile' || e.type.startsWith('run.')) && this.state.conversationId) {
        if (e.type !== 'run.delta') void this.refreshRuns();
      }
      if (this.state.brain !== 'local') return;
      if (this.localCancelled.has(e.data?.runId ?? e.data?.id)) return;
      if (e.type === 'run.delta' && e.data.kind === 'text') {
        if (this.state.runs.some((r) => r.id === e.data.runId) || e.data.taskId === this.state.conversationId) this.localDelta(e.data.runId, e.data.text);
      }
      if (e.type === 'run.finished' && e.data.task_id === this.state.conversationId && e.data.agent !== 'gemini') {
        if (!this.localAnswers.has(e.data.id)) this.localDelta(e.data.id, e.data.answer ?? '');
        const answer = this.localAnswers.get(e.data.id);
        if (answer) { for (const line of answer.stream.push('', true)) this.say(line); this.set({ output: plainAnswer(e.data.answer ?? answer.text) }); }
      }
    });
    this.lastSpeech = Date.now(); this.usageAt = Date.now(); this.idleEnding = false;
    this.interval = setInterval(() => this.tick(), 100);
    if (this.state.brain === 'local') { await this.startLocal(generation); return; }
    try {
      this.ctx = new AudioContext(); await this.ctx.resume(); this.playback = new PlaybackQueue(this.ctx);
      const client = new LiveClient({ message: (m) => this.message(m), state: (s) => {
        if (generation !== this.generation) return;
        this.set({ connection: s, model: client.model, status: s === 'Connected' ? 'listening' : 'connecting' });
        if (s === 'Connected') this.flushResponses();
      }, failure: (e) => { if (generation === this.generation) void this.fallback(e); } });
      this.client = client;
      await client.start(this.state.liveVoice);
      if (generation !== this.generation || this.state.brain !== 'gemini' || !client.session) return;
      await this.startMicrophone(generation);
    } catch (error) {
      if (generation !== this.generation) return;
      if ((error as Error).name === 'NotAllowedError') { await this.end(); this.set({ status: 'error', error: 'Microphone blocked. Allow microphone access in your browser, then retry.' }); }
      else await this.fallback(error as Error);
    }
  }
  private async startMicrophone(generation: number) {
    const { stream, missing } = await openMicrophone(voice.state.prefs.micId, true);
    if (generation !== this.generation || !this.ctx) { stream.getTracks().forEach((t) => t.stop()); return; }
    this.stream = stream;
    if (missing) this.set({ notice: 'Selected microphone unavailable; using system default' });
    const ctx = this.ctx; const encoder = new PcmEncoder(); let speech = false;
    this.gate = new SpeechGate((bytes) => {
      if (!this.client?.session || this.state.connection !== 'Connected') return;
      this.client.session.sendRealtimeInput({ audio: { data: base64(bytes), mimeType: 'audio/pcm;rate=16000' } });
      this.usage.inSec += bytes.length / 32000;
    }, () => this.client?.session?.sendRealtimeInput({ audioStreamEnd: true }));
    const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }));
    try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    if (generation !== this.generation) return;
    this.source = ctx.createMediaStreamSource(stream); this.worklet = new AudioWorkletNode(ctx, 'jarvis-capture');
    this.worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (generation !== this.generation) return;
      this.micLevel = this.state.muted ? 0 : rms(event.data);
      const allowed = !this.state.muted && (voice.state.prefs.interruptions === 'headset' || !this.playback?.speaking || this.pushHeld);
      for (const bytes of encoder.push(event.data, ctx.sampleRate)) this.gate?.push(bytes, speech, allowed);
    };
    this.source.connect(this.worklet); this.worklet.connect(ctx.destination);
    const { MicVAD } = await import('@ricky0123/vad-web');
    const vad = await MicVAD.new({
      model: 'v5', baseAssetPath: '/voice-runtime/vad/', onnxWASMBasePath: '/voice-runtime/vad/',
      audioContext: ctx,
      getStream: async () => stream, resumeStream: async () => stream,
      positiveSpeechThreshold: 0.6, negativeSpeechThreshold: 0.4, redemptionMs: 1200, preSpeechPadMs: 300, minSpeechMs: 160,
      onFrameProcessed: (p) => { speech = p.isSpeech > 0.4; },
      onSpeechStart: () => {
        if (this.state.muted || (this.playback?.speaking && voice.state.prefs.interruptions === 'speaker-safe' && !this.pushHeld)) return;
        this.lastSpeech = Date.now(); this.set({ status: 'hearing' });
      },
      onSpeechEnd: () => { speech = false; this.gate?.finish(); if (this.state.status === 'hearing') this.set({ status: 'thinking' }); },
      onVADMisfire: () => { speech = false; this.gate?.finish(); },
    });
    if (generation !== this.generation) { await vad.destroy(); return; }
    this.vad = vad;
  }
  private async closeGemini() {
    this.gate?.reset(); this.gate = null; this.client?.stop(); this.client = null;
    this.playback?.close(); this.playback = null;
    if (this.worklet) { this.worklet.port.onmessage = null; this.worklet.disconnect(); this.worklet = null; }
    this.source?.disconnect(); this.source = null;
    await this.vad?.destroy().catch(() => undefined); this.vad = null;
    this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null;
    await this.ctx?.close().catch(() => undefined); this.ctx = null;
  }
  private async fallback(error: Error) {
    if (this.state.brain === 'local') return;
    const notice = quotaFailure(error) ? "Gemini's free limit is reached; using local voice for now" : 'Gemini is unavailable; using local voice for now';
    this.set({ brain: 'local', notice, connection: 'Local' });
    await this.closeGemini();
    if (this.state.status === 'off') return;
    await this.startLocal(this.generation); this.say(notice);
  }
  private async startLocal(generation: number) {
    const previous = { utterance: voice.onUtterance, start: voice.onTurnStart, stop: voice.onStopSpeaking, recognition: voice.onRecognitionEnd };
    this.localRestore = () => { voice.onUtterance = previous.utterance; voice.onTurnStart = previous.start; voice.onStopSpeaking = previous.stop; voice.onRecognitionEnd = previous.recognition; };
    if (this.tools) this.tools.onRun = (id) => { this.localRunId = id; };
    this.local = new LocalTurn(async (text, signal) => {
      if (generation !== this.generation) return;
      this.set({ status: 'thinking', input: text, output: '' });
      try {
        const result = await this.tools!.handle('ask_agent', { request: `${text}\n\n[Voice reply: answer in at most 3 short spoken sentences. No lists or Markdown. Confirm before any outward-facing action.]`, agent: 'auto' }, signal);
        if (signal.aborted || generation !== this.generation) return;
        this.set({ output: String(result.answer ?? '') });
        if (result.status !== 'done') this.say(String(result.answer || 'The agent could not finish. Check the conversation on screen.'));
      } catch (error) { if (!signal.aborted && generation === this.generation) { this.set({ error: (error as Error).message, status: 'listening' }); this.say('I could not hand that off. Please try again.'); } }
    }, async () => {
      if (this.localRunId) this.localCancelled.add(this.localRunId);
      if (this.state.conversationId) await post(`/api/tasks/${this.state.conversationId}/cancel`);
    });
    voice.onUtterance = () => {};
    voice.onRecognitionEnd = (text) => { this.lastSpeech = Date.now(); this.local?.heard(text ?? ''); if (text) this.set({ input: this.local?.pendingText || text, status: 'thinking', error: '' }); };
    voice.onTurnStart = () => { this.lastSpeech = Date.now(); this.local?.speechStart(); ++this.speechEpoch; this.speechQueue = Promise.resolve(); voice.stopSpeaking(false); };
    voice.onStopSpeaking = () => { ++this.speechEpoch; this.speechQueue = Promise.resolve(); };
    this.localUnsub = voice.subscribe(() => {
      if (generation !== this.generation) return;
      const v = voice.state;
      this.micLevel = v.level; this.outputLevel = voice.outputLevel;
      this.set({ muted: v.muted, ...(v.status === 'error' ? { error: v.error ?? 'Local voice failed', status: 'error' as const } : {}),
        ...(v.status === 'speaking' || v.status === 'hearing' || v.status === 'loading' ? { status: v.status === 'loading' ? 'connecting' as const : v.status } : {}),
        ...(v.status === 'listening' && !['thinking', 'working'].includes(this.state.status) ? { status: 'listening' as const } : {}) });
    });
    this.set({ connection: 'Local', status: 'connecting' });
    await voice.start();
    if (generation === this.generation && voice.state.status !== 'error') this.set({ status: 'listening' });
  }
  private localDelta(id: string, text: string) {
    let answer = this.localAnswers.get(id);
    if (!answer) { answer = { text: '', stream: new SentenceStream(), started: false }; this.localAnswers.set(id, answer); }
    answer.text += text;
    this.set({ output: plainAnswer(answer.text) });
    for (const sentence of answer.stream.push(text)) {
      if (!answer.started) { answer.started = true; this.local?.answerStarted(); }
      this.say(plainAnswer(sentence));
    }
  }
  private say(text: string) {
    const epoch = this.speechEpoch;
    this.speechQueue = this.speechQueue.then(async () => { if (epoch === this.speechEpoch && this.state.status !== 'off') await voice.speak(text); }).catch(() => undefined);
  }
  private message(message: LiveServerMessage) {
    const content = message.serverContent;
    if (content?.interrupted) { this.playback?.flush(); this.outputLevel = 0; this.set({ status: 'hearing' }); }
    if (content?.inputTranscription?.text) this.set({ input: this.state.input + content.inputTranscription.text });
    if (content?.outputTranscription?.text) this.set({ output: this.state.output + content.outputTranscription.text });
    for (const part of content?.modelTurn?.parts ?? []) {
      if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('audio/pcm')) {
        const samples = decodePcm(part.inlineData.data); this.playback?.enqueue(samples); this.usage.outSec += samples.length / 24000;
        this.set({ status: 'speaking' });
      }
    }
    if (content?.turnComplete) {
      this.saveTurn();
      if (!this.playback?.speaking) this.set({ status: this.state.runs.length ? 'working' : 'listening' });
    }
    for (const id of message.toolCallCancellation?.ids ?? []) { this.toolCalls.get(id)?.abort(); this.toolCalls.delete(id); }
    for (const call of message.toolCall?.functionCalls ?? []) {
      if (!call.name) continue;
      const controller = new AbortController(); const id = call.id ?? call.name; this.toolCalls.set(id, controller);
      const generation = this.generation;
      void this.tools?.handle(call.name, call.args, controller.signal).then((result) => {
        if (controller.signal.aborted || generation !== this.generation) return;
        const failed = result.status === 'failed' || result.status === 'cancelled';
        this.respond({ id: call.id, name: call.name, response: result, scheduling: failed ? FunctionResponseScheduling.INTERRUPT : FunctionResponseScheduling.WHEN_IDLE });
      }).catch((error) => {
        if (!controller.signal.aborted && generation === this.generation) this.respond({ id: call.id, name: call.name, response: { error: (error as Error).message }, scheduling: FunctionResponseScheduling.INTERRUPT });
      }).finally(() => this.toolCalls.delete(id));
    }
  }
  private respond(response: FunctionResponse) { this.pendingResponses.push(response); this.flushResponses(); }
  private flushResponses() {
    if (!this.client?.session || this.state.connection !== 'Connected') return;
    while (this.pendingResponses.length) {
      try { this.client.session.sendToolResponse({ functionResponses: [this.pendingResponses[0]] }); this.pendingResponses.shift(); }
      catch { return; }
    }
  }
  private saveTurn() {
    const { input: user, output: assistant } = this.state;
    if (!user.trim() || !assistant.trim()) return;
    this.set({ lines: [...this.state.lines.slice(-2), { user, assistant }], input: '', output: '' });
    this.transcriptQueue = this.transcriptQueue.then(async () => {
      const result = await post<{ conversationId: string }>(`/api/conversations/${this.state.conversationId ?? 'new'}/voice-turns`, { user, assistant });
      this.changed(result.conversationId); if (this.tools) this.tools.conversationId = result.conversationId;
    }).catch((error) => this.set({ error: `Transcript could not be saved: ${(error as Error).message}` }));
  }
  private refreshBusy = false;
  async refreshRuns() {
    if (!this.state.conversationId || this.refreshBusy) return;
    const id = this.state.conversationId; this.refreshBusy = true;
    try {
      const detail = await api<{ runs: AgentRun[] }>(`/api/conversations/${id}`);
      if (id === this.state.conversationId) this.set({ runs: detail.runs.filter((r) => r.status === 'running') });
    } catch { /* SSE reconnect reconciles again. */ }
    finally { this.refreshBusy = false; }
  }
  private tick() {
    if (this.state.pendingInSec !== this.usage.inSec || this.state.pendingOutSec !== this.usage.outSec) this.set({ pendingInSec: this.usage.inSec, pendingOutSec: this.usage.outSec });
    this.outputLevel = this.playback?.level ?? voice.outputLevel;
    if (this.state.brain === 'gemini' && this.state.status === 'speaking' && !this.playback?.speaking) this.set({ status: this.state.runs.length ? 'working' : 'listening' });
    if (this.state.status === 'hearing') this.lastSpeech = Date.now();
    if (Date.now() - this.usageAt > 30000) { this.usageAt = Date.now(); void this.flushUsage(); }
    if (!this.idleEnding && Date.now() - this.lastSpeech > 120000) {
      this.idleEnding = true;
      if (this.state.brain === 'gemini') {
        this.gate?.reset(); this.set({ muted: true, notice: 'Session paused after two minutes without speech. Click Connect to return.' });
        this.client?.session?.sendClientContent({ turns: [{ role: 'user', parts: [{ text: 'End this session now. Say only: I’ll be here if you need me.' }] }], turnComplete: true });
        const generation = this.generation; setTimeout(() => { if (generation === this.generation) void this.end(); }, 6000);
      } else { this.say("I'll be here if you need me"); void this.speechQueue.finally(() => this.end()); }
    }
  }
  async flushUsage() {
    if (this.usageBusy || !this.usage.inSec && !this.usage.outSec) return;
    this.usageBusy = true; const usage = this.usage; this.usage = { inSec: 0, outSec: 0 };
    try { const total = await post<{ inSec: number; outSec: number }>('/api/voice/live/usage', usage); this.set({ ...total, pendingInSec: this.usage.inSec, pendingOutSec: this.usage.outSec }); }
    catch { this.usage.inSec += usage.inSec; this.usage.outSec += usage.outSec; this.set({ notice: 'Usage will sync when Jarvis reconnects' }); }
    finally { this.usageBusy = false; }
  }
  mute() { if (this.state.brain === 'local') { this.local?.resetRecognition(); voice.muteMic(); } else { this.set({ muted: !this.state.muted }); this.gate?.reset(); } }
  pushToTalk(held: boolean) { this.pushHeld = held; voice.pushToTalk = held; if (held && voice.state.prefs.interruptions === 'speaker-safe') { this.playback?.flush(); voice.stopSpeaking(false); } }
  async changeBrain(brain: 'gemini' | 'local') {
    const active = !['off', 'error'].includes(this.state.status); await this.end();
    rememberSetting('jarvis.voice.brain', brain); this.set({ brain, notice: '' }); if (active) await this.start();
  }
  async changeVoice(name: string) {
    rememberSetting('jarvis.voice.live.voice', name); this.set({ liveVoice: name });
    if (this.client) await this.client.start(name);
  }
  async changeMic(id: string) {
    voice.setPrefs({ micId: id });
    if (this.client) { const activeId = this.state.conversationId; await this.end(); await this.start(activeId); }
  }
  async end() {
    if (this.state.brain === 'gemini') this.saveTurn();
    ++this.generation; clearInterval(this.interval); this.interval = undefined;
    this.pushToTalk(false); ++this.speechEpoch; this.speechQueue = Promise.resolve(); this.local?.dispose(); this.local = null;
    this.tools?.dispose(); this.tools = null; for (const controller of this.toolCalls.values()) controller.abort(); this.toolCalls.clear();
    this.pendingResponses = [];
    this.events?.(); this.events = null; this.localUnsub?.(); this.localUnsub = null;
    this.localRestore?.(); this.localRestore = null; this.localAnswers.clear(); this.localCancelled.clear(); this.localRunId = null;
    this.set({ status: 'off', connection: 'Disconnected', runs: [], muted: false });
    await this.closeGemini(); await voice.stop(); voice.setFocusedSession(false);
    this.micLevel = 0; this.outputLevel = 0; await this.flushUsage();
  }
}
export const voiceSession = new VoiceSessionStore();
export function useVoiceSession() { return useSyncExternalStore(voiceSession.subscribe, () => voiceSession.state); }
