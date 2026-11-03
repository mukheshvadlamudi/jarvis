import { GoogleGenAI } from '@google/genai';
import type { LiveCallbacks, LiveConnectConfig, LiveServerMessage, Session } from '@google/genai';
import { api } from '../../lib/api.ts';
import { liveConfig } from './config.ts';
import type { Request } from './tools.ts';

export type LiveSession = Pick<Session, 'close' | 'sendRealtimeInput' | 'sendToolResponse' | 'sendClientContent'>;
export type Connect = (token: string, model: string, config: LiveConnectConfig, callbacks: LiveCallbacks) => Promise<LiveSession>;
const connect: Connect = (token, model, config, callbacks) => new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } }).live.connect({ model, config, callbacks });
export const modelFailure = (error: unknown) => /permission|billing|not.?found|quota|429|403|404|resource.exhausted|not.available|not.supported/i.test(String(error));
export const quotaFailure = (error: unknown) => /quota|429|resource.exhausted|free.tier/i.test(String(error));
export function dailyModel(choice?: 'primary' | 'fallback'): 'primary' | 'fallback' {
  const day = new Date().toLocaleDateString('en-CA');
  try {
    if (choice) localStorage.setItem('jarvis.voice.live.model', JSON.stringify({ day, choice }));
    const saved = JSON.parse(localStorage.getItem('jarvis.voice.live.model') ?? '{}');
    return saved.day === day && saved.choice === 'fallback' ? 'fallback' : 'primary';
  } catch { return choice ?? 'primary'; }
}

/** Owns token rotation and reconnects; injected connector keeps tests entirely offline. */
export class LiveClient {
  session: LiveSession | null = null;
  model = '';
  private request: Request;
  private connect: Connect;
  private onMessage: (message: LiveServerMessage) => void;
  private onState: (state: string) => void;
  private onFailure: (error: Error) => void;
  private handle: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private version = 0;
  private retries = 0;
  private rotating: Promise<void> | null = null;
  private voice = 'Puck';
  private choice: 'primary' | 'fallback' = 'primary';
  constructor(options: { message: (m: LiveServerMessage) => void; state: (s: string) => void; failure: (e: Error) => void; request?: Request; connect?: Connect }) {
    this.request = options.request ?? api; this.connect = options.connect ?? connect;
    this.onMessage = options.message; this.onState = options.state; this.onFailure = options.failure;
  }
  async start(voice: string) { this.stopped = false; this.voice = voice; this.choice = dailyModel(); await this.rotate(); }
  private rotate(): Promise<void> {
    if (this.rotating) return this.rotating;
    this.rotating = this.open().finally(() => { this.rotating = null; }); return this.rotating;
  }
  private async open(): Promise<void> {
    clearTimeout(this.timer);
    const version = ++this.version;
    this.session?.close(); this.session = null;
    if (this.stopped) return;
    this.onState(this.handle ? 'Reconnecting' : 'Connecting');
    try {
      const token = await this.request<{ token: string; model: string; expiresAt: string }>('/api/voice/live/token', { method: 'POST', body: { model: this.choice } });
      if (this.stopped || version !== this.version) return;
      this.model = token.model;
      let rejectSetup: (error: Error) => void = () => {};
      const failed = new Promise<never>((_, reject) => { rejectSetup = reject; });
      let ready = false;
      let recovering = false;
      const socket = this.connect(token.token, token.model, liveConfig(this.voice, this.handle), {
        onopen: () => {},
        onmessage: (message) => {
          if (this.stopped || version !== this.version) return;
          const update = message.sessionResumptionUpdate;
          if (message.serverContent) this.retries = 0;
          if (update?.resumable && update.newHandle) this.handle = update.newHandle;
          if (message.goAway) { clearTimeout(this.timer); this.timer = setTimeout(() => void this.rotate(), 100); }
          this.onMessage(message);
        },
        onerror: (event) => {
          if (version !== this.version || this.stopped) return;
          const error = new Error(event.message || 'Gemini connection failed');
          if (!ready) rejectSetup(error); else if (!recovering) { recovering = true; this.recover(error); }
        },
        onclose: (event) => {
          if (version !== this.version || this.stopped) return;
          const error = new Error(event.reason || 'Gemini connection closed');
          if (!ready) rejectSetup(error); else if (!recovering) { recovering = true; this.recover(error); }
        },
      });
      void socket.then((session) => { if (this.stopped || version !== this.version) session.close(); }).catch(() => undefined);
      const timeout = setTimeout(() => rejectSetup(new Error('Gemini connection timed out')), 15000);
      let session: LiveSession;
      try { session = await Promise.race([socket, failed]); }
      finally { clearTimeout(timeout); }
      if (this.stopped || version !== this.version) { session.close(); return; }
      ready = true; this.session = session;
      dailyModel(this.choice); this.onState('Connected');
      this.timer = setTimeout(() => void this.rotate(), Math.max(1000, Date.parse(token.expiresAt) - Date.now() - 60_000));
    } catch (error) {
      if (version !== this.version || this.stopped) return;
      // A failed open has no resumable context on the alternate model.
      if (this.choice === 'primary' && modelFailure(error)) {
        this.choice = 'fallback'; this.handle = undefined;
        await this.open(); return;
      }
      this.stop(); this.onFailure(error instanceof Error ? error : new Error(String(error)));
    }
  }
  private recover(error: Error) {
    clearTimeout(this.timer);
    if (modelFailure(error)) {
      if (this.choice === 'primary') { this.choice = 'fallback'; this.handle = undefined; this.timer = setTimeout(() => void this.rotate(), 100); }
      else { this.stop(); this.onFailure(error); }
      return;
    }
    if (++this.retries > 2) { this.stop(); this.onFailure(error); return; }
    this.onState('Reconnecting'); clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.rotate(), this.retries * 1000);
  }
  stop() { this.stopped = true; ++this.version; clearTimeout(this.timer); this.session?.close(); this.session = null; }
}
