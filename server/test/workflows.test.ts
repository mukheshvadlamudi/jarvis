import { afterEach, describe, expect, it } from 'vitest';
import { makeCtx, waitFor } from './helpers.ts';
import type { TestCtx } from './helpers.ts';
import { matches, render, validate } from '../src/workflows/model.ts';
import type { Definition } from '../src/workflows/model.ts';
import { builtins } from '../src/workflows/builtins.ts';
import { workflowsOf, Workflows } from '../src/workflows/service.ts';
import { all, run } from '../src/db/index.ts';
import type { Run } from '../src/types.ts';
import type { AgentRunner, RunInput } from '../src/runners/types.ts';
import { emptyUsage } from '../src/runners/types.ts';
import { createServices } from '../src/app.ts';
import { setupModules } from '../src/modules.ts';

let ctx: TestCtx;
afterEach(async () => { if (ctx) await ctx.close(); });
const done = (id: string) => waitFor(() => { const w = workflowsOf(ctx.s).get(id)!; return !['running','waiting_approval'].includes(w.status) && w; });
const definition = (prompt = '{{input}}'): Definition => ({ id: 'owner-routine', name: 'Owner routine', description: 'A saved routine', triggers: ['/routine'], input: { label: 'Request', required: true }, steps: [{ id: 'first', kind: 'agent', agent: 'codex', mode: 'read-only', prompt }, { id: 'summary', kind: 'summary', agent: 'claude', prompt: '{{steps.first.answer}}' }] });
const scripted = (answer: (i: RunInput, count: number) => string, fail = false): AgentRunner => {
  let count = 0;
  return { id: 'mock', start(input, sink) { const text = answer(input, ++count); sink.emit({ kind: 'message', payload: { role: 'assistant', text } }); return { cancel: async () => {}, done: Promise.resolve({ status: fail ? 'failed' : 'done', summary: text, ...(fail ? { error: text } : {}), usage: emptyUsage(), toolCalls: 0 }) }; } };
};

describe('workflow templates and definitions', () => {
  it('substitutes only known tokens once and caps every insertion', () => {
    const result = { answer: 'a'.repeat(7000), files: ['f'.repeat(7000)] };
    expect(render('{{input}}/{{steps.review.answer}}/{{steps.review.files}}', 'i'.repeat(7000), { review: result })).toHaveLength(18002);
    expect(render('{{input}} {{steps.missing.answer}} {{constructor}} {{steps.__proto__.answer}}', '{{steps.review.answer}}', { review: result })).toBe('{{steps.review.answer}}   ');
    expect(matches("steps.review.answer contains 'REQUEST CHANGES'", { review: { ...result, answer: 'REQUEST CHANGES: tests', state: 'done', attempts: 1 } })).toBe(true);
    expect(matches('process.exit()', {})).toBe(false);
  });
  it('validates built-ins and rejects unknown fields, unsafe ids and forward references', () => {
    builtins.forEach(d => expect(validate(d)).toEqual(d));
    for (const patch of [{ id: '../escape' }, { steps: [] }, { triggers: 'brief' }, { surprise: true }, { input: { label: 'Input', required: 'yes' } }, { steps: [{ id: 'first', kind: 'agent', agent: 'codex', mode: 'read-only', prompt: '{{steps.later.answer}}' }] }, { steps: [{ id: 'first', kind: 'gather', sources: ['shell:rm'] }] }]) expect(() => validate({ ...definition(), ...patch })).toThrow();
    expect(() => validate({ ...definition(), steps: [{ ...definition().steps[0], when: "steps.future.answer contains 'x'" }] })).toThrow(/earlier/);
  });
});

describe('workflow lifecycle with mock runner', () => {
  it('runs research and brief in Ask, preserving agent purpose, files and summary', async () => {
    ctx = makeCtx(); const service = workflowsOf(ctx.s);
    for (const id of ['research-and-verify','morning-brief']) {
      const started = await service.start(id, 'Postgres backups'); const w = await done(started.workflowRunId);
      expect(w.status).toBe('done'); expect(w.summary).toBeTruthy();
      expect(ctx.s.tasks.get(started.conversationId)?.mode).toBe('chat');
      const runs = all<Run>(ctx.s.db, 'SELECT * FROM runs WHERE task_id = ?', started.conversationId);
      expect(runs.every(r => r.purpose === 'workflow_step' && r.visibility === 'conversation')).toBe(true);
      if (id === 'research-and-verify') expect(w.results.research.files[0]).toMatch(/report.md$/);
    }
  });
  it('ships a fix through approval pause, resume and summary, skipping unneeded revisions', async () => {
    ctx = makeCtx(); const service = workflowsOf(ctx.s); const start = await service.start('ship-a-fix', 'Fix token refresh');
    const waiting = await waitFor(() => { const w = service.get(start.workflowRunId)!; return w.status === 'waiting_approval' && w; });
    expect(waiting.results.revise.state).toBe('skipped'); expect(waiting.results.publish).toBeUndefined();
    ctx.s.approvals.decide(waiting.results.approval.approvalId!, 'approved', null, 'web');
    expect((await done(start.workflowRunId)).status).toBe('done');
  });
  it('branches through one revision and re-review; keeps all agent steps sandboxed', async () => {
    const inputs: RunInput[] = []; let reviews = 0;
    const runner = scripted(i => { inputs.push(i); if (i.prompt.includes('Start your answer with')) return ++reviews === 1 ? 'REQUEST CHANGES: add a test' : 'APPROVE'; if (i.prompt.includes('Re-review the diff')) return 'APPROVE'; return 'Implemented and tested'; });
    ctx = makeCtx({ runnerOverrides: { claude: runner, codex: runner } });
    const service = workflowsOf(ctx.s); const start = await service.start('ship-a-fix', 'Fix session race');
    const w = await waitFor(() => { const w = service.get(start.workflowRunId)!; return w.status === 'waiting_approval' && w; });
    expect(w.results.revise.state).toBe('done'); expect(w.results.rereview.state).toBe('done');
    expect(inputs.filter(i => i.agent === 'codex').every(i => i.sandbox === 'read-only')).toBe(true);
    expect(inputs[0].sandbox).toBe('workspace-write');
    await service.cancel(w.id);
  });
  it('reject and cancel never start publishing', async () => {
    ctx = makeCtx(); const service = workflowsOf(ctx.s);
    for (const action of ['reject','cancel']) {
      const start = await service.start('ship-a-fix', 'Fix refresh');
      const w = await waitFor(() => { const w = service.get(start.workflowRunId)!; return w.status === 'waiting_approval' && w; });
      if (action === 'reject') ctx.s.approvals.decide(w.results.approval.approvalId!, 'rejected', null, 'web'); else await service.cancel(w.id);
      const ended = await done(w.id); expect(ended.status).toBe('cancelled'); expect(ended.results.publish).toBeUndefined();
    }
  });
  it('retries a failed step once, then fails clearly', async () => {
    ctx = makeCtx(); const service = workflowsOf(ctx.s); service.put(definition('[mock:fail]'));
    const start = await service.start('owner-routine', 'Fix missing module'); const w = await done(start.workflowRunId);
    expect(w.status).toBe('failed'); expect(w.results.first.attempts).toBe(2); expect(w.results.summary).toBeUndefined();
  });
  it('recovers after a transient failure and hands a limited step to the other agent', async () => {
    let attempt = 0;
    const runner: AgentRunner = { id: 'mock', start(i) { const failed = ++attempt === 1; return { cancel: async () => {}, done: Promise.resolve({ status: failed ? 'failed' : 'done', summary: failed ? 'Usage limit reached' : 'Completed after handover', error: failed ? 'Usage limit reached' : undefined, usage: emptyUsage(), toolCalls: 0 }) }; } };
    ctx = makeCtx({ runnerOverrides: { claude: runner, codex: runner } }); const service = workflowsOf(ctx.s); service.put(definition());
    const start = await service.start('owner-routine', 'Look up backups'); const w = await done(start.workflowRunId);
    expect(w.status).toBe('done'); expect(w.results.first.handedOver).toBe(true); expect(w.results.first.agent).toBe('claude');
  });
  it('recovers waiting approvals from disk and marks interrupted running steps', async () => {
    ctx = makeCtx(); let service = workflowsOf(ctx.s); const start = await service.start('ship-a-fix', 'Fix refresh');
    const w = await waitFor(() => { const w = service.get(start.workflowRunId)!; return w.status === 'waiting_approval' && w; });
    for (const close of ctx.s.closers.splice(-1)) await close();
    const reopened = createServices({ env: ctx.s.env }); setupModules(reopened);
    try {
      service = workflowsOf(reopened); service.recover();
      reopened.approvals.decide(w.results.approval.approvalId!, 'approved', null, 'web');
      expect((await waitFor(() => { const w = service.get(start.workflowRunId)!; return w.status === 'done' && w; })).status).toBe('done');
    } finally { await reopened.orchestrator.shutdown(); for (const close of reopened.closers) await close(); reopened.db.close(); }
    service = new Workflows(ctx.s); ctx.s.modules.workflows = service;
    run(ctx.s.db, "UPDATE workflow_runs SET status = 'running', current_step = 0, step_results_json = ? WHERE id = ?", JSON.stringify({ implement: { state: 'running', answer: '', files: [], attempts: 1 } }), w.id);
    service.recover(); expect(service.get(w.id)?.error).toMatch(/restart/);
  });
  it('stops live work through the existing Stop lifecycle', async () => {
    ctx = makeCtx(); const service = workflowsOf(ctx.s); service.put(definition('[mock:long]'));
    const start = await service.start('owner-routine', 'Long work');
    await waitFor(() => ctx.s.orchestrator.isActive(start.conversationId));
    await ctx.s.orchestrator.cancel(start.conversationId);
    expect((await done(start.workflowRunId)).status).toBe('cancelled');
  });
  it('tracks approval-guarded agent tools and resumes without escaping the graph', async () => {
    ctx = makeCtx(); const service = workflowsOf(ctx.s);
    service.put({ ...definition('[mock:approval]'), steps: [{ ...definition('[mock:approval]').steps[0], mode: 'write' }, definition().steps[1]] });
    const start = await service.start('owner-routine', 'Prepare branch');
    const w = await waitFor(() => { const w = service.get(start.workflowRunId)!; return w.status === 'waiting_approval' && w; });
    expect(w.results.first.state).toBe('waiting_approval');
    ctx.s.approvals.decide(w.results.first.approvalId!, 'approved', null, 'web');
    expect((await done(w.id)).status).toBe('done');
  });
});

it('serves strict CRUD, start, detail and cancel APIs', async () => {
  ctx = makeCtx();
  expect((await ctx.req('GET','/api/workflows')).json.workflows).toHaveLength(3);
  expect((await ctx.req('POST','/api/workflows',{ ...definition(), id: '../bad' })).status).toBe(400);
  expect((await ctx.req('POST','/api/workflows',definition())).status).toBe(200);
  expect((await ctx.req('DELETE','/api/workflows/morning-brief')).status).toBe(400);
  const response = await ctx.req('POST','/api/workflows/owner-routine/run',{ input: 'Backups' });
  expect(response.status).toBe(201); const w = await done(response.json.workflowRunId);
  expect((await ctx.req('GET',`/api/workflow-runs/${w.id}`)).json.status).toBe('done');
  expect((await ctx.req('POST',`/api/workflow-runs/${w.id}/cancel`)).status).toBe(200);
  expect((await ctx.req('GET','/api/workflow-runs/missing')).status).toBe(404);
  expect((await ctx.req('DELETE','/api/workflows/owner-routine')).status).toBe(200);
  expect(workflowsOf(ctx.s).get(w.id)?.definition.name).toBe('Owner routine');
});

describe('workflow gather: speakable usage', () => {
  it('turns ISO reset times into local, relative phrases', async () => {
    const { speakableUsage } = await import('../src/workflows/service.ts');
    const now = Date.parse('2026-11-03T08:00:00Z');
    const w = (pct: number, at: string | null) => ({ usedPercent: pct, resetsAt: at, source: 'probe', estimate: false, tokens: null, ts: '' });
    const out = speakableUsage({ claude: { five_hour: w(41.6, '2026-11-03T11:00:00Z'), weekly: w(23, '2026-11-08T08:00:00Z') }, codex: { five_hour: null, weekly: w(30, null) } } as never, now);
    expect(out.Claude.five_hour).toMatch(/^42% used, resets .+ local time \(in 3 h 0 min\)$/);
    expect(out.Claude.five_hour).not.toMatch(/T11:00|UTC|Z\b/);
    expect(out.Claude.weekly).toMatch(/in 5 days/);
    expect(out.Codex).toEqual({ five_hour: 'not reported yet', weekly: '30% used' });
  });
});
