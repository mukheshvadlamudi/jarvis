import { afterEach, describe, expect, it } from 'vitest';
import { sanitizedAgentEnv } from '../src/util/env.ts';
import { GeminiLive, pickLiveModel } from '../src/voice/gemini.ts';
import { makeCtx } from './helpers.ts';
import type { TestCtx } from './helpers.ts';

let ctx: TestCtx;
afterEach(async () => ctx?.close());

function fakeAi(calls: Array<Record<string, unknown>>) {
  return async () => ({
    authTokens: { create: async (p: { config: Record<string, unknown> }) => (calls.push(p.config), { name: 'auth_tokens/eph-123' }) },
    models: {
      list: async () =>
        (async function* () {
          yield { name: 'models/gemini-2.5-flash', supportedActions: ['generateContent'] };
          yield { name: 'models/gemini-2.5-flash-native-audio-preview', supportedActions: ['bidiGenerateContent'] };
          yield { name: 'models/gemini-3.1-flash-live-preview', supportedActions: ['bidiGenerateContent'] };
          yield { name: 'models/gemini-3.1-flash-native-audio-preview', supportedActions: ['bidiGenerateContent'] };
        })(),
    },
  });
}

describe('Gemini Live voice brain', () => {
  it('picks the newest native-audio Live model', () => {
    expect(
      pickLiveModel([
        { name: 'models/gemini-2.5-flash', actions: ['generateContent'] },
        { name: 'models/gemini-2.5-flash-native-audio-preview', actions: ['bidiGenerateContent'] },
        { name: 'models/gemini-3.1-flash-live-preview', actions: ['bidiGenerateContent'] },
        { name: 'models/gemini-3.1-flash-native-audio-preview', actions: ['bidiGenerateContent'] },
        { name: 'models/gemini-3.8-live', actions: ['bidiGenerateContent'] },
        { name: 'models/gemini-3.8-live-extended-thinking', actions: ['bidiGenerateContent'] },
        { name: 'models/gemini-3.5-transcribe-live', actions: ['bidiGenerateContent'] },
        { name: 'models/gemini-robotics-er-2-streaming-preview', actions: ['bidiGenerateContent'] },
      ]),
    ).toBe('gemini-3.8-live');
    expect(pickLiveModel([{ name: 'models/gemini-2.5-flash', actions: ['generateContent'] }])).toBeNull();
  });

  it('hands out a single-use ephemeral token, never the key', async () => {
    ctx = makeCtx({ env: { GEMINI_API_KEY: 'AIzaSyFAKEFAKEFAKEFAKEFAKEFAKEFAKE00' } });
    const calls: Array<Record<string, unknown>> = [];
    const live = new GeminiLive(ctx.s, fakeAi(calls));
    const t = await live.token();
    expect(t).toMatchObject({ token: 'auth_tokens/eph-123', model: 'gemini-3.1-flash-native-audio-preview' }); // newest in the fake list
    expect(calls[0]).toMatchObject({ uses: 1 });
    expect(JSON.stringify(t)).not.toContain('AIza');
  });

  it('reports not configured without a key', async () => {
    ctx = makeCtx();
    const r = await ctx.req('GET', '/api/voice/live');
    expect(r.json).toMatchObject({ configured: false });
    expect((await ctx.req('POST', '/api/voice/live/token')).status).toBe(409);
  });

  it('never passes the Gemini key to Claude Code or Codex', () => {
    const env = sanitizedAgentEnv({ PATH: '/bin', GEMINI_API_KEY: 'AIza-secret', GOOGLE_API_KEY: 'x', HOME: '/h' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h' });
  });
});
