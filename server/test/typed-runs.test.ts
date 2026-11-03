import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { all } from '../src/db/index.ts';
import { collabOf } from '../src/collab/index.ts';
import { handle } from '../src/mcp/stdio.ts';
import { emptyUsage } from '../src/runners/types.ts';
import type { AgentRunner, RunHandle, RunInput, RunResult } from '../src/runners/types.ts';
import type { Run, RunPurpose } from '../src/types.ts';
import { makeCtx, REPO, waitFor } from './helpers.ts';
import type { TestCtx } from './helpers.ts';

let ctx: TestCtx | undefined;
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await ctx?.close(); ctx = undefined; });

function controlled() {
  const calls: Array<{ input: RunInput; finish: (status?: RunResult['status']) => void; cancelled: boolean }> = [];
  const runner: AgentRunner = { id: 'mock', start(input, sink): RunHandle {
    let resolve!: (r: RunResult) => void;
    const done = new Promise<RunResult>((r) => { resolve = r; });
    const call = { input, cancelled: false, finish(status: RunResult['status'] = 'done') {
      resolve({ status, summary: input.prompt, usage: emptyUsage(), toolCalls: 0, sessionId: input.runId });
    } };
    calls.push(call);
    sink.live?.({ kind: 'text', text: 'Working' });
    sink.emit({ kind: 'message', payload: { role: 'assistant', text: input.prompt } });
    return { done, cancel: async () => { call.cancelled = true; call.finish('cancelled'); } };
  } };
  return { runner, calls };
}

function insert(taskId: string, id: string, purpose: RunPurpose, visibility: string, answer: string) {
  ctx!.s.db.prepare("INSERT INTO runs (id, task_id, agent, cwd, started_at, status, purpose, visibility, owner_text, prompt, answer, route_reason) VALUES (?, ?, 'claude', '.', ?, 'done', ?, ?, ?, 'EXECUTABLE SECRET', ?, 'learning: misleading label')")
    .run(id, taskId, new Date().toISOString(), purpose, visibility, purpose === 'user_reply' ? 'Owner text [jarvis:learn]' : null, answer);
}

describe('typed runs', () => {
  it('stores exact owner text and hands only conversation content to a new agent', async () => {
    const c = controlled(); ctx = makeCtx({ runnerOverrides: { claude: c.runner, codex: c.runner } });
    const t = ctx.s.tasks.create({ title: 'Discuss the release', mode: 'chat', run: false });
    const text = '  Owner text\n\n---\n\nNew message from the owner:\nkeep this literal  ';
    const first = await ctx.s.orchestrator.ask(t.id, text, { agent: 'claude' });
    c.calls[0].finish(); await waitFor(() => !ctx!.s.orchestrator.isActive(t.id));
    expect(ctx.s.orchestrator.getRun(first.runId!)).toMatchObject({ purpose: 'user_reply', visibility: 'conversation', owner_text: text, parent_run_id: null });
    insert(t.id, 'private', 'learning', 'internal', 'PRIVATE LEARNING');
    insert(t.id, 'consult', 'consult', 'activity', 'PRIVATE CONSULT');
    await ctx.s.orchestrator.ask(t.id, 'Next question', { agent: 'codex' });
    expect(c.calls[1].input.prompt).toContain(text);
    expect(c.calls[1].input.prompt).not.toMatch(/PRIVATE|EXECUTABLE/);
  });

  it('excludes internal and consult content from history, previews and conversation search', async () => {
    ctx = makeCtx(); const t = ctx.s.tasks.create({ title: 'Discuss the release', mode: 'chat', run: false });
    insert(t.id, 'owner', 'user_reply', 'conversation', 'Public answer');
    insert(t.id, 'learning', 'learning', 'internal', 'PRIVATE LEARNING');
    insert(t.id, 'consult', 'consult', 'activity', 'PRIVATE CONSULT');
    const history = ctx.s.orchestrator.history(t.id);
    expect(history).toContain('Owner text [jarvis:learn]');
    expect(history).not.toMatch(/PRIVATE|EXECUTABLE/);
    const detail = await ctx.req('GET', '/api/conversations/' + t.id);
    expect(detail.json.runs.map((r: Run) => r.id)).toEqual(['owner', 'consult']);
    expect((await ctx.req('GET', '/api/conversations')).json.conversations[0].preview).toBe('Public answer');
    for (const q of ['PRIVATE', 'EXECUTABLE']) expect((await ctx.req('GET', '/api/conversations?q=' + q)).json.conversations).toEqual([]);
    expect((await ctx.req('GET', '/api/conversations?q=Public')).json.conversations).toHaveLength(1);
  });

  it.each(['both', 'second_opinion', 'consult', 'learning', 'maintenance', 'verify'] as const)('types, tracks and cancels a %s side run under its task', async (purpose) => {
    const c = controlled(); ctx = makeCtx({ runnerOverrides: { claude: c.runner, codex: c.runner } });
    const t = ctx.s.tasks.create({ title: 'Discuss release', mode: 'chat', run: false });
    insert(t.id, 'parent', 'user_reply', 'conversation', 'Answer');
    const pending = ctx.s.orchestrator.sideRun(t.id, { purpose, parentRunId: 'parent', agent: 'codex', cwd: ctx.dir, prompt: 'Side work', label: 'arbitrary label', resumeSessionId: null, contextPrefix: 'Context' });
    const row = ctx.s.orchestrator.getRun(c.calls[0].input.runId)!;
    expect(row).toMatchObject({ purpose, visibility: purpose === 'consult' ? 'activity' : ['both', 'second_opinion'].includes(purpose) ? 'conversation' : 'internal', owner_text: null, parent_run_id: 'parent' });
    expect(ctx.s.orchestrator.activeRuns()).toContainEqual({ taskId: t.id, runId: row.id, agent: 'codex', visibility: row.visibility });
    const token = c.calls[0].input.mcpServers!.jarvis.env.JARVIS_MCP_TOKEN;
    await ctx.s.orchestrator.cancel(t.id); expect((await pending).status).toBe('cancelled');
    expect(c.calls[0].cancelled).toBe(true); expect(ctx.s.orchestrator.activeCount()).toBe(0);
    const res = await ctx.app.request('/api/mcp/call', { method: 'POST', headers: { 'content-type': 'application/json', 'x-jarvis-run': row.id, 'x-jarvis-mcp-token': token }, body: JSON.stringify({ tool: 'get_usage', args: {} }) });
    expect(res.status).toBe(401);
  });

  it('stops the parent and its consult, and refuses a consult when the parent holds the only slot', async () => {
    const c = controlled(); ctx = makeCtx({ runnerOverrides: { claude: c.runner, codex: c.runner } });
    const t = ctx.s.tasks.create({ title: 'Release question', mode: 'chat', run: false });
    const main = await ctx.s.orchestrator.ask(t.id, 'Question', { agent: 'claude' });
    ctx.s.config.update({ maxConcurrentRuns: 1 });
    expect(await collabOf(ctx.s).consult({ taskId: t.id, runId: main.runId! }, 'Check this?')).toMatchObject({ ok: false });
    expect(c.calls).toHaveLength(1);
    ctx.s.config.update({ maxConcurrentRuns: 2 });
    const pending = collabOf(ctx.s).consult({ taskId: t.id, runId: main.runId! }, 'Check this?');
    await waitFor(() => c.calls.length === 2);
    expect(ctx.s.orchestrator.getRun(c.calls[1].input.runId)).toMatchObject({ purpose: 'consult', parent_run_id: main.runId });
    await ctx.s.orchestrator.cancel(t.id); await pending;
    expect(c.calls.every((c) => c.cancelled)).toBe(true);
  });

  it('keeps internal work invisible and accepts owner messages while it runs', async () => {
    const c = controlled(); ctx = makeCtx({ runnerOverrides: { claude: c.runner, codex: c.runner } });
    const t = ctx.s.tasks.create({ title: 'Release', mode: 'chat', run: false });
    const pending = ctx.s.orchestrator.sideRun(t.id, { purpose: 'learning', parentRunId: null, agent: 'codex', cwd: ctx.dir, prompt: 'Private', label: 'learning', resumeSessionId: null });
    expect((await ctx.req('GET', '/api/conversations/' + t.id)).json).toMatchObject({ runs: [], active: false });
    const next = await ctx.req('POST', '/api/conversations/' + t.id + '/messages', { text: '  Exact owner text  ', agent: 'claude' });
    expect(next.status).toBe(200);
    expect(ctx.s.orchestrator.getRun(next.json.runId)?.owner_text).toBe('  Exact owner text  ');
    expect(c.calls).toHaveLength(2);
    await ctx.s.orchestrator.cancel(t.id); await pending;
  });

  it('links Ask both and second opinion to the actual answer they accompany', async () => {
    ctx = makeCtx({ mockDelayMs: 1 });
    const first = await ctx.req('POST', '/api/conversations', { text: 'Is the release ready?', agent: 'both' });
    expect(first.status).toBe(201);
    const id = first.json.conversation.id;
    await waitFor(() => !ctx!.s.orchestrator.isActive(id));
    const runs = ctx.s.orchestrator.runsForTask(id);
    const parent = runs.find((r) => r.purpose === 'user_reply')!;
    expect(runs.find((r) => r.purpose === 'both')).toMatchObject({ parent_run_id: parent.id, visibility: 'conversation', owner_text: null });
    expect((await ctx.req('POST', '/api/conversations/' + id + '/second-opinion', { runId: parent.id })).status).toBe(200);
    await waitFor(() => !ctx!.s.orchestrator.isActive(id));
    expect(ctx.s.orchestrator.runsForTask(id).find((r) => r.purpose === 'second_opinion')).toMatchObject({ parent_run_id: parent.id, visibility: 'conversation', owner_text: null });
  });

  it('types scheduled memory consolidation as internal maintenance without conversation write-back', async () => {
    const c = controlled(); ctx = makeCtx({ runnerOverrides: { claude: c.runner, codex: c.runner } });
    ctx.s.db.prepare("INSERT INTO schedules (id, name, cron, task_template_json, enabled, created_at, built_in) VALUES ('maintenance', 'Consolidation', '0 0 * * 0', ?, 0, ?, NULL)").run(JSON.stringify({ routine: 'memory_consolidation' }), new Date().toISOString());
    const t = ctx.s.tasks.create({ title: 'Consolidate memory', type: 'memory', schedule_id: 'maintenance' });
    const after = vi.fn(); ctx.s.orchestrator.afterRun.push(after);
    ctx.s.orchestrator.tick(); await waitFor(() => c.calls.length === 1);
    expect(ctx.s.orchestrator.getRun(c.calls[0].input.runId)).toMatchObject({ purpose: 'maintenance', visibility: 'internal', owner_text: null, parent_run_id: null });
    c.calls[0].finish(); await waitFor(() => !ctx!.s.orchestrator.isActive(t.id));
    expect(after).not.toHaveBeenCalled();
    expect(ctx.s.orchestrator.history(t.id)).not.toContain('Consolidate memory');
  });

  it('marks interrupted side runs failed on recovery', () => {
    ctx = makeCtx(); const t = ctx.s.tasks.create({ title: 'Release', run: false });
    for (const purpose of ['consult', 'both', 'second_opinion', 'learning'] as const) {
      insert(t.id, purpose, purpose, purpose === 'learning' ? 'internal' : purpose === 'consult' ? 'activity' : 'conversation', '');
      ctx.s.db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(purpose);
    }
    ctx.s.orchestrator.recover();
    expect(all<Run>(ctx.s.db, 'SELECT * FROM runs').every((r) => r.status === 'failed' && r.ended_at && r.error?.includes('Jarvis stopped'))).toBe(true);
    expect(ctx.s.tasks.get(t.id)?.status).toBe('inbox');
  });

  it('sends an increasing reconnect epoch and active snapshot, filtering internal streams', async () => {
    const c = controlled(); ctx = makeCtx({ runnerOverrides: { claude: c.runner, codex: c.runner } });
    const t = ctx.s.tasks.create({ title: 'Release', mode: 'chat', run: false });
    const main = await ctx.s.orchestrator.ask(t.id, 'Question', { agent: 'claude' });
    const pending = ctx.s.orchestrator.sideRun(t.id, { purpose: 'learning', parentRunId: main.runId!, agent: 'codex', cwd: ctx.dir, prompt: 'Private', label: 'learning', resumeSessionId: null });
    const open = async () => {
      const res = await ctx!.app.request('/api/stream');
      const reader = res.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      const hello = JSON.parse(first.split('data: ')[1].split('\n')[0]);
      return { reader, hello };
    };
    const first = await open(); const second = await open();
    expect(second.hello.epoch).toBeGreaterThan(first.hello.epoch);
    expect(first.hello.active).toEqual([{ taskId: t.id, runId: main.runId, agent: 'claude', visibility: 'conversation' }]);
    for (const type of ['run.started', 'run.event', 'run.delta', 'run.finished']) ctx.s.bus.publish(type, { visibility: 'internal', marker: 'PRIVATE' });
    ctx.s.bus.publish('run.delta', { visibility: 'conversation', marker: 'PUBLIC' });
    const next = new TextDecoder().decode((await first.reader.read()).value);
    expect(next).toContain('PUBLIC'); expect(next).not.toContain('PRIVATE');
    await first.reader.cancel(); await second.reader.cancel();
    await ctx.s.orchestrator.cancel(t.id); await pending;
  });

  it('backfills legacy run labels and owner text once', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const dir = join(REPO, 'server/src/db/migrations');
      for (const file of readdirSync(dir).filter((f) => /^00[1-6]_/.test(f)).sort()) db.exec(readFileSync(join(dir, file), 'utf8'));
      db.prepare("INSERT INTO tasks (id, title, type, status, created_at, updated_at) VALUES ('t', 'Release', 'other', 'done', '1', '1')").run();
      const labels = ['', 'side:both:answer', 'side:second opinion:review', 'consult: question', 'learning loop: skill proposal'];
      labels.forEach((label, i) => db.prepare("INSERT INTO runs (id, task_id, agent, cwd, started_at, status, route_reason, prompt) VALUES (?, 't', 'claude', '.', ?, 'done', ?, ?)").run('r' + i, String(i), label, 'Earlier context\n\n---\n\nNew message from the owner:\nActual owner text'));
      db.prepare("INSERT INTO tasks (id, title, type, status, created_at, updated_at, handoff_json) VALUES ('handoff', 'Review', 'other', 'done', '1', '1', ?)").run(JSON.stringify({ fromRun: 'r0' }));
      db.prepare("INSERT INTO runs (id, task_id, agent, cwd, started_at, status) VALUES ('review', 'handoff', 'codex', '.', '5', 'done')").run();
      db.exec(readFileSync(join(dir, '007_run_purpose.sql'), 'utf8'));
      expect(all<Run>(db, "SELECT * FROM runs WHERE id = 'review'")[0]).toMatchObject({ purpose: 'handoff', owner_text: null, parent_run_id: 'r0', visibility: 'conversation' });
      expect(all<Run>(db, "SELECT * FROM runs WHERE task_id = 't' ORDER BY id").map((r) => [r.purpose, r.visibility, r.owner_text, r.parent_run_id])).toEqual([
        ['user_reply', 'conversation', 'Actual owner text', null], ['both', 'conversation', null, 'r0'], ['second_opinion', 'conversation', null, 'r0'], ['consult', 'activity', null, 'r0'], ['learning', 'internal', null, 'r0'],
      ]);
      db.exec('PRAGMA foreign_keys = ON');
      db.prepare("DELETE FROM tasks WHERE id = 't'").run();
      expect(all<Run>(db, "SELECT * FROM runs WHERE id = 'review'")[0].parent_run_id).toBeNull();
    } finally { db.close(); }
  });
});

describe('MCP metadata and deadlines', () => {
  it('returns honest read and mutation annotations from tools/list', async () => {
    const list = await handle({ id: 1, method: 'tools/list' }) as { result: { tools: Array<{ name: string; annotations: Record<string, boolean> }> } };
    for (const tool of list.result.tools) {
      const read = ['search_memory', 'search_conversations', 'read_note', 'list_projects', 'get_usage'].includes(tool.name);
      expect(tool.annotations.readOnlyHint).toBe(read);
      if (read) expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    }
    expect(list.result.tools.find((t) => t.name === 'save_memory')?.annotations.destructiveHint).toBe(true);
    expect(list.result.tools.find((t) => t.name === 'notify_owner')?.annotations.openWorldHint).toBe(true);
  });

  it.each([['read_note', 30_000], ['request_approval', 600_000], ['consult_agent', 600_000]] as const)('times out %s with a useful tool error', async (name, ms) => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(5));
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
    })));
    const result = await handle({ id: 1, method: 'tools/call', params: { name, arguments: {} } }) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(spy).toHaveBeenCalledWith(ms);
    expect(result.result.isError).toBe(true);
    expect(result.result.content[0].text).toContain('timed out after ' + ms / 1000 + ' seconds');
    expect(result.result.content[0].text).toContain('may still be pending');
  });
});
