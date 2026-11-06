import { afterEach, describe, expect, it } from 'vitest';
import { makeCtx, waitFor } from './helpers.ts';
import type { TestCtx } from './helpers.ts';

let ctx: TestCtx;
afterEach(async () => ctx?.close());

const status = (id: string) => ctx.s.tasks.get(id)?.status;

describe('task lifecycle (mock runner)', () => {
  it('creates, routes, streams events live and finishes', async () => {
    ctx = makeCtx({ mockDelayMs: 2 });
    const seen: string[] = [];
    ctx.s.bus.subscribe((e) => seen.push(e.type));
    const r = await ctx.req('POST', '/api/tasks', { title: 'Fix the login redirect bug' });
    expect(r.status).toBe(201);
    const id = r.json.task.id;
    await waitFor(() => status(id) === 'done');
    const detail = await ctx.req('GET', `/api/tasks/${id}`);
    expect(detail.json.task).toMatchObject({ type: 'code', agent: 'claude', route_reason: 'code → claude' });
    expect(detail.json.task.result_summary).toMatch(/^Fixed: Fix the login redirect bug/);
    const runId = detail.json.runs[0].id;
    const run = await ctx.req('GET', `/api/runs/${runId}`);
    expect(run.json.run.context_report.items[0].label).toBe('Jarvis instructions');
    const ev = await ctx.req('GET', `/api/runs/${runId}/events`);
    expect(ev.json.events.map((e: { kind: string }) => e.kind)).toContain('file_change');
    expect(run.json.run.tool_calls).toBe(4);
    expect(seen).toContain('run.event');
    expect(seen).toContain('run.finished');
  });

  it('parks tasks in the inbox when run=false and queues on demand', async () => {
    ctx = makeCtx();
    const r = await ctx.req('POST', '/api/tasks', { title: 'Research Postgres backup tools', run: false });
    expect(r.json.task.status).toBe('inbox');
    const q = await ctx.req('POST', `/api/tasks/${r.json.task.id}/run`, { agent: 'claude' });
    expect(q.status).toBe(200);
    await waitFor(() => status(r.json.task.id) === 'done');
    expect(ctx.s.tasks.get(r.json.task.id)?.agent).toBe('claude');
  });

  it('enforces the concurrency limit with a queue', async () => {
    ctx = makeCtx({ mockDelayMs: 5 });
    ctx.s.config.update({ maxConcurrentRuns: 2 });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await ctx.req('POST', '/api/tasks', { title: `Long build ${i} [mock:long]` })).json.task.id);
    await waitFor(() => ids.filter((id) => status(id) === 'running').length === 2);
    expect(ids.filter((id) => status(id) === 'queued').length).toBe(2);
    await ctx.req('POST', `/api/tasks/${ids[0]}/cancel`);
    await waitFor(() => status(ids[0]) === 'cancelled');
    await waitFor(() => status(ids[2]) === 'running');
    expect(ctx.s.orchestrator.activeCount()).toBe(2);
  });

  it('pauses on an approval and resumes when approved', async () => {
    ctx = makeCtx({ mockDelayMs: 2 });
    const id = (await ctx.req('POST', '/api/tasks', { title: 'Ship the fix [mock:approval]', type: 'code' })).json.task.id;
    await waitFor(() => status(id) === 'needs_you');
    const list = await ctx.req('GET', '/api/approvals?status=pending');
    expect(list.json.pending).toBe(1);
    const a = list.json.approvals[0];
    expect(a).toMatchObject({ kind: 'git_push', live: true, task_title: 'Ship the fix [mock:approval]' });
    expect(a.detail.input.command).toMatch(/^git push/);
    const d = await ctx.req('POST', `/api/approvals/${a.id}`, { decision: 'approved', note: 'go' });
    expect(d.json.approval.status).toBe('approved');
    await waitFor(() => status(id) === 'done');
    const again = await ctx.req('POST', `/api/approvals/${a.id}`, { decision: 'rejected' });
    expect(again.status).toBe(409);
  });

  it('a rejected approval lets the run finish without the action', async () => {
    ctx = makeCtx({ mockDelayMs: 2 });
    const id = (await ctx.req('POST', '/api/tasks', { title: 'Ship the fix [mock:approval]', type: 'code' })).json.task.id;
    await waitFor(() => status(id) === 'needs_you');
    const a = ctx.s.approvals.list('pending')[0];
    await ctx.req('POST', `/api/approvals/${a.id}`, { decision: 'rejected' });
    await waitFor(() => status(id) === 'done');
    expect(ctx.s.tasks.get(id)?.result_summary).toMatch(/rejected/);
  });

  it('expires stale approvals and leaves the task needing you', async () => {
    ctx = makeCtx({ mockDelayMs: 2 });
    const id = (await ctx.req('POST', '/api/tasks', { title: 'Ship the fix [mock:approval]', type: 'code' })).json.task.id;
    await waitFor(() => status(id) === 'needs_you');
    ctx.s.approvals.expireOld(24, Date.now() + 25 * 3600_000);
    await waitFor(() => ctx.s.tasks.get(id)?.result_summary?.includes('expired'));
    expect(status(id)).toBe('needs_you');
  });

  it('cancels a running task', async () => {
    ctx = makeCtx({ mockDelayMs: 5 });
    const id = (await ctx.req('POST', '/api/tasks', { title: 'Watch the build [mock:long]' })).json.task.id;
    await waitFor(() => status(id) === 'running');
    await ctx.req('POST', `/api/tasks/${id}/cancel`);
    await waitFor(() => status(id) === 'cancelled');
    expect(ctx.s.orchestrator.runsForTask(id)[0].status).toBe('cancelled');
  });

  it('delivers follow-ups live, and resumes the session after a run ends', async () => {
    ctx = makeCtx({ mockDelayMs: 2 });
    const id = (await ctx.req('POST', '/api/tasks', { title: 'Watch the build [mock:long]' })).json.task.id;
    await waitFor(() => ctx.s.orchestrator.runsForTask(id)[0]?.tool_calls === 1);
    const live = await ctx.req('POST', `/api/tasks/${id}/followup`, { text: 'also run lint' });
    expect(live.json.mode).toBe('live');
    await waitFor(() => status(id) === 'done');
    const firstRun = ctx.s.orchestrator.runsForTask(id)[0];
    const resumed = await ctx.req('POST', `/api/tasks/${id}/followup`, { text: 'now update the changelog' });
    expect(resumed.json.mode).toBe('resumed');
    await waitFor(() => status(id) === 'done' && ctx.s.orchestrator.runsForTask(id).length === 2);
    const runs = ctx.s.orchestrator.runsForTask(id);
    expect(runs[0].session_id).toBe(firstRun.session_id);
    expect(runs[0].prompt).toBe('now update the changelog');
    expect(runs[0].route_reason).toMatch(/follow-up resumes/);
  });

  it('records failures', async () => {
    ctx = makeCtx({ mockDelayMs: 1 });
    const id = (await ctx.req('POST', '/api/tasks', { title: 'Run the suite [mock:fail]' })).json.task.id;
    await waitFor(() => status(id) === 'failed');
    expect(ctx.s.orchestrator.runsForTask(id)[0].error).toMatch(/missing module/);
  });

  it('holds tasks while both plans are exhausted', async () => {
    ctx = makeCtx();
    const reset = new Date(Date.now() + 3600_000).toISOString();
    for (const agent of ['claude', 'codex'] as const) {
      ctx.s.usage.recordReading({ agent, window: 'five_hour', usedPercent: 95, resetsAt: reset, source: 'test' });
    }
    const id = (await ctx.req('POST', '/api/tasks', { title: 'Write the weekly update' })).json.task.id;
    await waitFor(() => ctx.s.tasks.get(id)?.not_before);
    expect(ctx.s.tasks.get(id)).toMatchObject({ status: 'queued', not_before: reset });
    expect(ctx.s.tasks.get(id)?.route_reason).toMatch(/both agents/);
  });

  it('truncates huge tool output in stored events', async () => {
    ctx = makeCtx();
    const id = ctx.s.tasks.create({ title: 'x', run: false }).id;
    const runId = 'r_test';
    ctx.s.db.prepare("INSERT INTO runs (id, task_id, agent, cwd, started_at, status) VALUES (?, ?, 'claude', '/tmp', ?, 'running')").run(runId, id, new Date().toISOString());
    const sink = (ctx.s.orchestrator as unknown as { makeSink: (a: string, b: string, c: string) => { emit: (e: unknown) => void } }).makeSink(id, runId, 'claude');
    sink.emit({ kind: 'tool_result', payload: { id: 'x', output: 'y'.repeat(100_000) } });
    const ev = ctx.s.orchestrator.events(runId)[0];
    const payload = JSON.parse(ev.payload_json);
    expect(payload.truncated).toBe(true);
    expect(ev.payload_json.length).toBeLessThan(22_000);
  });

  it('validates input and transitions', async () => {
    ctx = makeCtx();
    expect((await ctx.req('POST', '/api/tasks', { title: '  ' })).status).toBe(400);
    const id = ctx.s.tasks.create({ title: 'Inbox item', run: false }).id;
    expect((await ctx.req('PATCH', `/api/tasks/${id}`, { status: 'running' })).status).toBe(409);
    expect((await ctx.req('PATCH', `/api/tasks/${id}`, { status: 'done', priority: 3 })).json.task).toMatchObject({ status: 'done', priority: 3 });
    expect((await ctx.req('GET', '/api/tasks/t_missing')).status).toBe(404);
    const preview = await ctx.req('POST', '/api/tasks/preview', { text: 'Research the best Postgres backup tools' });
    expect(preview.json).toMatchObject({ type: 'research', agent: 'codex', reason: 'research → codex' });
  });
});

describe('access token', () => {
  it('requires the token on API calls when configured', async () => {
    ctx = makeCtx({ env: { JARVIS_ACCESS_TOKEN: 'tok', JARVIS_BIND: '0.0.0.0' } });
    expect((await ctx.req('GET', '/api/tasks')).status).toBe(401);
    expect((await ctx.req('GET', '/api/health')).status).toBe(200);
    const ok = await ctx.app.request('/api/tasks', { headers: { authorization: 'Bearer tok' } });
    expect(ok.status).toBe(200);
    expect((await ctx.app.request('/api/tasks?token=tok')).status).toBe(401);
    expect((await ctx.app.request('/api/tasks?token=tok', { method: 'POST' })).status).toBe(401);
    expect((await ctx.app.request('/api/tasks/missing/outputs/raw?token=tok')).status).toBe(404);
    const stream = await ctx.app.request('/api/stream?token=tok');
    expect(stream.status).toBe(200);
    await stream.body?.cancel();
  });
});

describe('local origin guard', () => {
  const post = (url: string, headers: Record<string, string> = {}) =>
    ctx.app.request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ text: 'hello' }) });

  it('refuses non-loopback hosts without a token (DNS rebinding)', async () => {
    ctx = makeCtx();
    expect((await ctx.app.request('http://evil.example:4317/api/tasks')).status).toBe(403);
    expect((await ctx.app.request('http://127.0.0.1:4317/api/tasks')).status).toBe(200);
    expect((await ctx.app.request('http://localhost:5173/api/tasks')).status).toBe(200);
  });

  it('refuses cross-site writes from a browser', async () => {
    ctx = makeCtx();
    expect((await post('http://127.0.0.1:4317/api/tasks', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post('http://127.0.0.1:4317/api/tasks', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await post('http://127.0.0.1:4317/api/tasks', { origin: 'null' })).status).toBe(403);
    expect((await post('http://127.0.0.1:4317/api/tasks', { origin: 'http://127.0.0.1:8080' })).status).toBe(403);
    expect((await post('http://127.0.0.1:4317/api/tasks/preview', { origin: 'http://127.0.0.1:4317' })).status).toBe(200);
  });

  it('leaves remote access to the token when one is set', async () => {
    ctx = makeCtx({ env: { JARVIS_ACCESS_TOKEN: 'tok', JARVIS_BIND: '0.0.0.0' } });
    const res = await ctx.app.request('http://100.64.0.5:4317/api/tasks', { headers: { authorization: 'Bearer tok' } });
    expect(res.status).toBe(200);
  });
});
