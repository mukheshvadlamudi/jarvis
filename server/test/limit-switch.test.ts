import { afterEach, describe, expect, it } from 'vitest';
import { LIMIT_ERROR } from '../src/tasks/orchestrator.ts';
import { makeCtx, waitFor } from './helpers.ts';
import type { TestCtx } from './helpers.ts';

let ctx: TestCtx;
afterEach(async () => ctx?.close());

const runs = (id: string) => [...ctx.s.orchestrator.runsForTask(id)].reverse();

describe('switch agents when a plan runs out mid-task', () => {
  it('recognises Claude and Codex limit messages, not ordinary failures', () => {
    for (const m of ["You've hit your usage limit. Try again at 11:35 AM.", 'Claude AI usage limit reached|1762160000', 'rate_limit_error', '429 Too Many Requests', 'RESOURCE_EXHAUSTED: quota'])
      expect(LIMIT_ERROR.test(m)).toBe(true);
    for (const m of ['Test suite could not start: missing module ./config', 'Failed to authenticate: OAuth session expired'])
      expect(LIMIT_ERROR.test(m)).toBe(false);
  });

  it('continues a background task on Codex in the same folder with what Claude already did', async () => {
    ctx = makeCtx({ mockDelayMs: 1 });
    const t = ctx.s.tasks.create({ title: 'Write the launch notes [mock:limit]', type: 'write', agent_pref: 'claude' });
    ctx.s.orchestrator.tick();
    await waitFor(() => runs(t.id).length === 2 && runs(t.id).every((r) => r.status !== 'running'));
    const [first, second] = runs(t.id);
    expect(first).toMatchObject({ agent: 'claude', status: 'failed' });
    expect(second).toMatchObject({ agent: 'codex', route_reason: 'limit handover: claude → codex', cwd: first.cwd });
    expect(second.prompt).toContain('Claude reached its plan limit part-way through');
    expect(second.prompt).toContain('notes.md');
    expect(second.prompt).toContain('Drafted the first half in notes.md.');
    // Claude is now marked as at its limit, so the router avoids it until the reset.
    expect(ctx.s.usage.current().claude.five_hour).toMatchObject({ usedPercent: 100, source: 'limit-hit' });
    // The handover run hit the limit too (same mock prompt): it does not bounce back to Claude.
    await waitFor(() => ctx.s.tasks.get(t.id)?.status === 'failed');
    expect(runs(t.id)).toHaveLength(2);
    expect(ctx.s.tasks.get(t.id)?.result_summary).toMatch(/plan limit/);
  });

  it('continues a conversation on the other agent with the conversation so far', async () => {
    ctx = makeCtx({ mockDelayMs: 1 });
    const id = (await ctx.req('POST', '/api/conversations', { text: 'Plan my week [mock:limit]', agent: 'claude' })).json.conversation.id;
    await waitFor(() => runs(id).length >= 2 && runs(id).every((r) => r.status !== 'running'));
    const [first, second] = runs(id);
    expect(first.agent).toBe('claude');
    expect(second).toMatchObject({ agent: 'codex', route_reason: 'limit handover: claude → codex', owner_text: first.owner_text });
  });

  it('can be turned off', async () => {
    ctx = makeCtx({ mockDelayMs: 1 });
    ctx.s.config.update({ router: { switchOnLimit: false } });
    const t = ctx.s.tasks.create({ title: 'Write the launch notes [mock:limit]', type: 'write', agent_pref: 'claude' });
    ctx.s.orchestrator.tick();
    await waitFor(() => ctx.s.tasks.get(t.id)?.status === 'failed');
    expect(runs(t.id)).toHaveLength(1);
  });
});

describe('after a spoken exchange', () => {
  it('a typed follow-up is routed normally instead of failing on the voice brain', async () => {
    ctx = makeCtx({ mockDelayMs: 1 });
    const id = (await ctx.req('POST', '/api/conversations', { text: 'Plan my day', agent: 'claude' })).json.conversation.id;
    await waitFor(() => ctx.s.tasks.get(id)?.status === 'done');
    const v = await ctx.req('POST', `/api/conversations/${id}/voice-turns`, { user: 'What is on my calendar?', assistant: 'You have two meetings this afternoon.' });
    expect(v.status).toBe(201);
    const r = await ctx.req('POST', `/api/conversations/${id}/messages`, { text: 'Move the second one to Friday' });
    expect(r.status).toBe(200);
    await waitFor(() => ctx.s.tasks.get(id)?.status === 'done' && !ctx.s.orchestrator.isActive(id));
    const last = ctx.s.orchestrator.runsForTask(id)[0];
    expect(['claude', 'codex']).toContain(last.agent);
    expect(last.prompt).toContain('Jarvis (voice): You have two meetings this afternoon.');
  });
});
