import { afterEach, expect, it } from 'vitest';
import { makeCtx } from './helpers.ts';
import type { TestCtx } from './helpers.ts';
let ctx: TestCtx;
afterEach(async () => ctx?.close());
it('persists a voice pair as a completed visible Gemini reply without running an agent', async () => {
  ctx = makeCtx();
  const created = await ctx.req('POST', '/api/conversations/new/voice-turns', { user: 'What is two plus two?', assistant: 'Four.' });
  expect(created.status).toBe(201);
  const id = created.json.conversationId;
  const saved = await ctx.req('POST', `/api/conversations/${id}/voice-turns`, { user: 'Thanks', assistant: 'You’re welcome.' });
  expect(saved.status).toBe(201);
  const detail = await ctx.req('GET', `/api/conversations/${id}`);
  expect(detail.json.runs).toHaveLength(2);
  expect(detail.json.runs[0]).toMatchObject({ agent: 'gemini', status: 'done', purpose: 'user_reply', visibility: 'conversation', owner_text: 'What is two plus two?', answer: 'Four.' });
  expect(detail.json.active).toBe(false);
  expect(ctx.s.orchestrator.activeRuns()).toHaveLength(0);
});
it('rejects missing conversations and invalid or oversized text', async () => {
  ctx = makeCtx();
  expect((await ctx.req('POST', '/api/conversations/missing/voice-turns', { user: 'Hi', assistant: 'Hello' })).status).toBe(404);
  for (const payload of [{ user: 'Hi' }, { user: 2, assistant: 'Hi' }, { user: '  ', assistant: 'Hi' }, { user: 'x'.repeat(20001), assistant: 'Hi' }]) {
    expect((await ctx.req('POST', '/api/conversations/new/voice-turns', payload)).status).toBe(400);
  }
});
it('stores daily audio totals and validates usage boundaries without contacting Google', async () => {
  ctx = makeCtx();
  expect((await ctx.req('GET', '/api/voice/live/usage')).json).toMatchObject({ inSec: 0, outSec: 0 });
  await ctx.req('POST', '/api/voice/live/usage', { inSec: 60, outSec: 120 });
  expect((await ctx.req('POST', '/api/voice/live/usage', { inSec: 15, outSec: 5 })).json).toMatchObject({ inSec: 75, outSec: 125 });
  for (const inSec of [-1, '60', null, 7201]) expect((await ctx.req('POST', '/api/voice/live/usage', { inSec, outSec: 0 })).status).toBe(400);
});
