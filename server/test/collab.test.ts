import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collabOf } from '../src/collab/index.ts';
import { mcpOf } from '../src/mcp/module.ts';
import { makeCtx, waitFor } from './helpers.ts';
import type { TestCtx } from './helpers.ts';

let ctx: TestCtx;
afterEach(async () => ctx?.close());

async function call(tool: string, args: Record<string, unknown>, run: string, token: string) {
  const res = await ctx.app.request('/api/mcp/call', { method: 'POST', headers: { 'content-type': 'application/json', 'x-jarvis-run': run, 'x-jarvis-mcp-token': token }, body: JSON.stringify({ tool, args }) });
  return (await res.json()) as { text: string; isError?: boolean };
}

function fakeRun(taskId: string, agent: 'claude' | 'codex') {
  const id = `r_${agent}${Math.floor(Math.random() * 1e6)}`;
  const cwd = mkdtempSync(join(tmpdir(), 'jarvis-run-'));
  ctx.s.db.prepare("INSERT INTO runs (id, task_id, agent, cwd, started_at, status) VALUES (?, ?, ?, ?, ?, 'running')").run(id, taskId, agent, cwd, new Date().toISOString());
  return id;
}

describe('consult_agent', () => {
  it('lets Claude ask Codex (and records both sides), up to the per-task limit', async () => {
    ctx = makeCtx({ mockDelayMs: 1 });
    const t = ctx.s.tasks.create({ title: 'Fix the token refresh race', run: false });
    const runId = fakeRun(t.id, 'claude');
    const token = mcpOf(ctx.s).issue(runId, t.id);
    const r = await call('consult_agent', { question: 'Is a per-user lock enough here?', context: 'diff…' }, runId, token);
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^Codex says:\nAgree with the per-user lock/);
    const runs = ctx.s.orchestrator.runsForTask(t.id);
    expect(runs.find((x) => x.route_reason === 'consult: Claude asked Codex')).toMatchObject({ agent: 'codex', status: 'done' });
    const events = ctx.s.orchestrator.events(runId).map((e) => JSON.parse(e.payload_json));
    expect(events.map((e) => e.phase)).toEqual(['asked', 'answered']);
    await call('consult_agent', { question: 'Second?' }, runId, token);
    const third = await call('consult_agent', { question: 'Third?' }, runId, token);
    expect(third).toMatchObject({ isError: true });
    expect(third.text).toMatch(/limit reached/);
  });

  it('refuses when the other plan is near its limit', async () => {
    ctx = makeCtx({ mockDelayMs: 1 });
    ctx.s.usage.recordReading({ agent: 'claude', window: 'five_hour', usedPercent: 93, resetsAt: new Date(Date.now() + 3600_000).toISOString(), source: 'test' });
    const t = ctx.s.tasks.create({ title: 'x', run: false });
    const runId = fakeRun(t.id, 'codex');
    const r = await collabOf(ctx.s).consult({ runId, taskId: t.id }, 'Q?');
    expect(r).toMatchObject({ ok: false });
    expect(r.text).toMatch(/Claude is at 93%/);
  });
});

describe('handoffs', () => {
  it('a finished task hands off to the other agent for a read-only review in the same folder', async () => {
    ctx = makeCtx({ mockDelayMs: 1 });
    const id = (await ctx.req('POST', '/api/tasks', { title: 'Fix the login redirect bug' })).json.task.id;
    await waitFor(() => ctx.s.tasks.get(id)?.status === 'done');
    const first = ctx.s.orchestrator.runsForTask(id)[0];
    const r = await ctx.req('POST', `/api/tasks/${id}/handoff`, { mode: 'review' });
    expect(r.json.mode).toBe('now');
    const child = r.json.task;
    expect(child).toMatchObject({ title: 'Review: Fix the login redirect bug', agent_pref: 'codex', parent_id: id });
    expect(child.body).toContain('What Claude did');
    await waitFor(() => ctx.s.tasks.get(child.id)?.status === 'done');
    const childRun = ctx.s.orchestrator.runsForTask(child.id)[0];
    expect(childRun).toMatchObject({ agent: 'codex', cwd: first.cwd });
    const links = await ctx.req('GET', `/api/tasks/${child.id}/links`);
    expect(links.json.origin).toMatchObject({ fromTask: id, mode: 'review', fromAgent: 'claude' });
    expect((await ctx.req('GET', `/api/tasks/${id}/links`)).json.children[0].id).toBe(child.id);
  });

  it('planned handoffs fire when the task finishes (and via the agent tool)', async () => {
    ctx = makeCtx({ mockDelayMs: 2 });
    const id = (await ctx.req('POST', '/api/tasks', { title: 'Research uptime monitors', run: false })).json.task.id;
    expect((await ctx.req('POST', `/api/tasks/${id}/handoff`, { mode: 'continue', instructions: 'Write it up as a client email draft.' })).json.mode).toBe('after');
    await ctx.req('POST', `/api/tasks/${id}/run`);
    await waitFor(() => ctx.s.tasks.list({ q: 'Continue: Research uptime monitors' }).length === 1);
    const child = ctx.s.tasks.list({ q: 'Continue: Research uptime monitors' })[0];
    expect(child.agent_pref).toBe('claude');
    expect(child.body.startsWith('Write it up as a client email draft.')).toBe(true);
    expect(ctx.s.tasks.get(id)?.then_json).toBeNull();
  });

  it('auto review handoff for code tasks when enabled', async () => {
    ctx = makeCtx({ mockDelayMs: 1 });
    ctx.s.config.update({ collaboration: { autoHandoffReview: true } });
    const id = (await ctx.req('POST', '/api/tasks', { title: 'Refactor the session store code' })).json.task.id;
    await waitFor(() => ctx.s.tasks.list({ q: 'Review: Refactor the session store' }).length === 1);
    expect(ctx.s.tasks.list({ q: 'Review: Refactor the session store' })[0].parent_id).toBe(id);
  });
});
