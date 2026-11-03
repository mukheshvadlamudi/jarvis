/**
 * Gemini Live as Jarvis's voice brain. The API key stays in this process: the browser asks for a
 * short-lived, single-use ephemeral token per voice session and connects to Gemini Live with it.
 * Coded against @google/genai's shipped genai.d.ts (auth tokens are v1alpha-only).
 */
import type { Hono } from 'hono';
import type { Services } from '../app.ts';
import { logger } from '../util/log.ts';
import { getSetting, setSetting } from '../db/index.ts';

const log = logger('voice-live');
const MODEL_TTL_MS = 6 * 3600_000;

interface GenAiLike {
  authTokens: { create(p: { config: Record<string, unknown> }): Promise<{ name?: string }> };
  models: { list(p?: Record<string, unknown>): Promise<AsyncIterable<{ name?: string; supportedActions?: string[] }>> };
}
export type GenAiFactory = (apiKey: string) => Promise<GenAiLike>;

const defaultFactory: GenAiFactory = async (apiKey) => {
  const { GoogleGenAI } = await import('@google/genai');
  return new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } }) as unknown as GenAiLike;
};

/**
 * The newest general-purpose Live model: highest version first, stable before preview, native
 * audio as a tie-break. Special-purpose Live models (transcribe, translate, robotics, extended
 * thinking — slower to answer) are never picked for conversation.
 */
export function pickLiveModel(names: Array<{ name: string; actions: string[] }>): string | null {
  const live = names.filter((m) => (m.actions.includes('bidiGenerateContent') || /live|native-audio/i.test(m.name)) && !/transcribe|translate|robotics|thinking|tts/i.test(m.name));
  if (!live.length) return null;
  const version = (n: string) => Number(/gemini-(\d+(?:\.\d+)?)/.exec(n)?.[1] ?? 0);
  const rank = (n: string) => (/latest/.test(n) ? 4 : /preview/.test(n) ? 0 : 2) + (/native-audio/.test(n) ? 1 : 0);
  live.sort((x, y) => version(y.name) - version(x.name) || rank(y.name) - rank(x.name) || y.name.localeCompare(x.name));
  return live[0].name.replace(/^models\//, '');
}

export function pickFallbackModel(names: Array<{ name: string; actions: string[] }>): string | null {
  const native = names.filter((m) => m.name.includes('native-audio'));
  const latest = native.filter((m) => m.name.includes('latest'));
  const stable = native.filter((m) => !/preview|experimental/.test(m.name));
  return pickLiveModel(latest.length ? latest : stable.length ? stable : native);
}

export class GeminiLive {
  private s: Services;
  private factory: GenAiFactory;
  private model: { name: string | null; at: number } = { name: null, at: 0 };
  private fallback: string | null = null;

  constructor(s: Services, factory: GenAiFactory = defaultFactory) {
    this.s = s;
    this.factory = factory;
  }

  get configured(): boolean {
    return !!this.s.env.geminiKey;
  }

  async liveModel(): Promise<string | null> {
    if (this.model.name && Date.now() - this.model.at < MODEL_TTL_MS) return this.model.name;
    const ai = await this.factory(this.s.env.geminiKey!);
    const found: Array<{ name: string; actions: string[] }> = [];
    for await (const m of await ai.models.list({ config: { pageSize: 200 } })) {
      if (m.name) found.push({ name: m.name, actions: m.supportedActions ?? [] });
    }
    this.fallback = pickFallbackModel(found);
    this.model = { name: this.s.env.geminiLiveModel || pickLiveModel(found), at: Date.now() };
    return this.model.name;
  }

  async fallbackModel(): Promise<string | null> { await this.liveModel(); return this.fallback; }

  /** One ephemeral token: one session, must connect within 60 s, session capped at 30 minutes. */
  async token(choice: 'primary' | 'fallback' = 'primary'): Promise<{ token: string; model: string; fallbackModel: string | null; expiresAt: string }> {
    if (!this.s.env.geminiKey) throw new Error('not_configured');
    const model = choice === 'fallback' ? await this.fallbackModel() : await this.liveModel();
    if (!model) throw new Error('This Gemini key has no Live (voice) model available.');
    const ai = await this.factory(this.s.env.geminiKey);
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const t = await ai.authTokens.create({
      config: { uses: 1, expireTime: expiresAt, newSessionExpireTime: new Date(Date.now() + 60_000).toISOString(), httpOptions: { apiVersion: 'v1alpha' } },
    });
    if (!t.name) throw new Error('Gemini did not return a token.');
    return { token: t.name, model, fallbackModel: this.fallback, expiresAt };
  }
}

export function registerVoiceLiveRoutes(app: Hono, s: Services): void {
  const live = new GeminiLive(s);
  s.modules.voiceLive = live;

  const today = () => new Date().toLocaleDateString('en-CA');
  const totals = () => getSetting(s.db, `voice.usage.${today()}`, { inSec: 0, outSec: 0 });
  app.get('/api/voice/live/usage', (c) => c.json({ day: today(), ...totals() }));
  app.post('/api/voice/live/usage', async (c) => {
    const b = await c.req.json().catch(() => null) as { inSec?: unknown; outSec?: unknown } | null;
    if (!b || ![b.inSec, b.outSec].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 7200)) return c.json({ error: 'invalid_usage', message: 'Audio seconds must be finite numbers from 0 to 7200.' }, 400);
    const previous = totals();
    const next = { inSec: previous.inSec + Number(b.inSec), outSec: previous.outSec + Number(b.outSec) };
    setSetting(s.db, `voice.usage.${today()}`, next);
    s.bus.publish('usage.updated', { voice: next });
    return c.json({ day: today(), ...next });
  });

  app.get('/api/voice/live', async (c) => {
    if (!live.configured) return c.json({ configured: false, model: null, fallbackModel: null, hint: 'Add GEMINI_API_KEY to .env and restart Jarvis.' });
    try {
      return c.json({ configured: true, model: await live.liveModel(), fallbackModel: await live.fallbackModel() });
    } catch (err) {
      log.warn('gemini model lookup failed', friendly(err));
      return c.json({ configured: true, model: null, error: friendly(err) });
    }
  });

  app.post('/api/voice/live/token', async (c) => {
    const b = await c.req.json().catch(() => ({})) as { model?: unknown } | null;
    if (!b || b.model !== undefined && b.model !== 'primary' && b.model !== 'fallback') return c.json({ error: 'invalid_model' }, 400);
    try {
      return c.json(await live.token(b.model));
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === 'not_configured') return c.json({ error: 'not_configured', message: 'Gemini voice is not set up. Add GEMINI_API_KEY to .env and restart Jarvis.' }, 409);
      log.warn('gemini token failed', friendly(err));
      return c.json({ error: 'gemini', message: friendly(err) }, 502);
    }
  });
}

/** Turn Gemini errors into one actionable line; never echo the key. */
function friendly(err: unknown): string {
  const m = String((err as Error)?.message ?? err).replace(/AIza[0-9A-Za-z_-]{20,}/g, '[key]');
  if (/API key not valid|API_KEY_INVALID|401|403/i.test(m)) return 'Gemini rejected the key. Check GEMINI_API_KEY in .env (create one at aistudio.google.com/app/apikey).';
  if (/quota|429|RESOURCE_EXHAUSTED/i.test(m)) return 'Gemini free-tier limit reached for now. Jarvis will use Local voice until it resets.';
  return `Gemini voice is unavailable: ${m.slice(0, 200)}`;
}
