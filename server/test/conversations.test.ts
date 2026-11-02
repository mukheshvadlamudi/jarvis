import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentsService } from '../src/agents/service.ts';
import { decide, headroomPick } from '../src/router/index.ts';
import { activityLine } from '../src/runners/activity.ts';
import { buildClaudePrompt } from '../src/runners/claude.ts';
import { buildCodexInput } from '../src/runners/codex.ts';
import type { RunInput } from '../src/runners/types.ts';
import { FIXTURE_VAULT, makeCtx, waitFor } from './helpers.ts';
import type { TestCtx } from './helpers.ts';

let ctx: TestCtx;
afterEach(async () => ctx?.close());

const conv = async (id: string) => (await ctx.req('GET', `/api/conversations/${id}`)).json;
const idle = (id: string) => waitFor(() => !ctx.s.orchestrator.isActive(id) && ctx.s.tasks.get(id)?.status === 'done');

async function upload(name: string, mime: string, data: Buffer | string) {
  const res = await ctx.app.request('/api/uploads', { method: 'POST', headers: { 'content-type': mime, 'x-filename': encodeURIComponent(name) }, body: data });
  return (await res.json()) as { upload: { id: string; name: string; mime: string; size: number } };
}

describe('conversations', () => {
  it('answers a question at once, streams thinking and text live, and stores the answer', async () => {
    ctx = makeCtx({ mockDelayMs: 2 });
    const deltas: string[] = [];
    ctx.s.bus.subscribe((e) => {
      if (e.type === 'run.delta') deltas.push((e.data as { kind: string }).kind);
    });
    const r = await ctx.req('POST', '/api/conversations', { text: 'Is the token refresh fix safe to ship?' });
    expect(r.status).toBe(201);
    const id = r.json.conversation.id;
    expect(r.json.conversation.mode).toBe('chat');
    await idle(id);
    const c = await conv(id);
    expect(c.runs).toHaveLength(1);
    expect(c.runs[0].route_reason).toMatch(/^question → claude \(more room/);
    expect(c.runs[0].answer).toMatch(/^Short answer/);
    const kinds = c.runs[0].events.map((e: { kind: string; payload: { role?: string } }) => (e.kind === 'message' ? `message:${e.payload.role}` : e.kind));
    expect(kinds[0]).toBe('message:reasoning');
    expect(kinds).toContain('tool_call');
    const call = c.runs[0].events.find((e: { kind: string }) => e.kind === 'tool_call');
    expect(call.payload.activity).toMatch(/^(Searching the code for|Checking your notes for|Reading) /);
    expect(deltas).toContain('thinking');
    expect(deltas).toContain('text');
    // Conversations stay off the Board and are searchable by their answers.
    expect((await ctx.req('GET', '/api/tasks?mode=task')).json.tasks).toHaveLength(0);
    expect((await ctx.req('GET', '/api/conversations?q=per-user lock')).json.conversations[0].id).toBe(id);
  });

  it('keeps a follow-up with the same agent and session, and hands the history over on a switch', async () => {
    ctx = makeCtx({ mockDelayMs: 1 });
    const id = (await ctx.req('POST', '/api/conversations', { text: 'What changed in the auth middleware?', agent: 'claude' })).json.conversation.id;
    await idle(id);
    await ctx.req('POST', `/api/conversations/${id}/messages`, { text: 'And the tests?' });
    await idle(id);
    let runs = (await conv(id)).runs;
    expect(runs[1]).toMatchObject({ agent: 'claude', route_reason: 'follow-up stays with claude', session_id: runs[0].session_id });
    expect(runs[1].prompt).toBe('And the tests?');
    const sw = await ctx.req('POST', `/api/conversations/${id}/messages`, { text: 'Codex, double-check that', agent: 'codex', model: 'gpt-5.6-luna', effort: 'high' });
    expect(sw.status).toBe(200);
    await idle(id);
    runs = (await conv(id)).runs;
    expect(runs[2]).toMatchObject({ agent: 'codex', route_reason: 'you chose codex', model: 'gpt-5.6-luna', effort: 'high' });
    expect(runs[2].session_id).not.toBe(runs[1].session_id);
    expect(runs[2].prompt).toMatch(/^Earlier in this conversation/);
    expect(runs[2].prompt).toContain('Owner: What changed in the auth middleware?');
    expect(runs[2].prompt).toMatch(/New message from the owner:\nCodex, double-check that$/);
  });

  it('refuses a new message while the last one is still being answered', async () => {
    ctx = makeCtx({ mockDelayMs: 5 });
    const id = (await ctx.req('POST', '/api/conversations', { text: 'Watch the build [mock:long]' })).json.conversation.id;
    await waitFor(() => ctx.s.tasks.get(id)?.status === 'running');
    const busy = await ctx.req('POST', `/api/conversations/${id}/messages`, { text: 'hello?' });
    expect(busy.status).toBe(409);
    expect(busy.json.message).toMatch(/still answering/);
    await ctx.req('POST', `/api/tasks/${id}/cancel`);
  });

  it('copies attachments into the run folder and tells the agent where they are', async () => {
    ctx = makeCtx({ mockDelayMs: 1 });
    const png = await upload('screen shot.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const doc = await upload('notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'PK fake docx');
    expect(png.upload).toMatchObject({ name: 'screen shot.png', mime: 'image/png', size: 4 });
    const id = (await ctx.req('POST', '/api/conversations', { text: 'What is in these files?', attachments: [png.upload.id, doc.upload.id] })).json.conversation.id;
    await idle(id);
    const run = (await conv(id)).runs[0];
    const att = JSON.parse(run.attachments_json);
    expect(att.map((a: { name: string }) => a.name)).toEqual(['screen shot.png', 'notes.docx']);
    expect(existsSync(join(run.cwd, 'attachments', 'notes.docx'))).toBe(true);
    expect(run.answer).toContain('I read the file you attached (screen shot.png, notes.docx)');
    expect((await upload('', 'text/plain', 'x')).upload).toBeUndefined();
  });

  it('ask both: the other agent answers the same message beside the main answer', async () => {
    ctx = makeCtx({ mockDelayMs: 1 });
    const png = await upload('chart.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const id = (await ctx.req('POST', '/api/conversations', { text: 'Which backup tool should I use?', agent: 'both', attachments: [png.upload.id] })).json.conversation.id;
    await waitFor(() => ctx.s.orchestrator.runsForTask(id).length === 2 && ctx.s.orchestrator.runsForTask(id).every((r) => r.status === 'done'));
    const runs = (await conv(id)).runs;
    expect(runs.map((r: { agent: string }) => r.agent).sort()).toEqual(['claude', 'codex']);
    const second = runs.find((r: { agent: string }) => r.agent === 'codex');
    expect(second.route_reason).toBe('side:both:Codex answered too');
    // The second answer sees the same files as the first.
    expect(JSON.parse(second.attachments_json)[0].name).toBe('chart.png');
    expect(second.answer).toContain('chart.png');
  });

  it('second opinion: the other agent checks the last answer with the conversation in view', async () => {
    ctx = makeCtx({ mockDelayMs: 1 });
    const id = (await ctx.req('POST', '/api/conversations', { text: 'Should I rotate refresh tokens?', agent: 'claude' })).json.conversation.id;
    await idle(id);
    const r = await ctx.req('POST', `/api/conversations/${id}/second-opinion`, {});
    expect(r.json).toMatchObject({ ok: true, agent: 'codex' });
    await waitFor(() => ctx.s.orchestrator.runsForTask(id).some((x) => x.agent === 'codex' && x.status === 'done'));
    const side = ctx.s.orchestrator.runsForTask(id).find((x) => x.agent === 'codex')!;
    expect(side.route_reason).toBe('side:second opinion:Codex checked Claude');
    expect(side.prompt).toContain('Owner: Should I rotate refresh tokens?');
    expect(side.prompt).toContain('second opinion on Claude');
    // A later follow-up still goes back to Claude: side runs never take over the conversation.
    await ctx.req('POST', `/api/conversations/${id}/messages`, { text: 'Thanks' });
    await idle(id);
    expect(ctx.s.orchestrator.runsForTask(id)[0]).toMatchObject({ agent: 'claude', route_reason: 'follow-up stays with claude' });
  });

  it('remember saves a line to the vault inbox', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'jarvis-vault-'));
    cpSync(FIXTURE_VAULT, vault, { recursive: true });
    ctx = makeCtx({ env: { JARVIS_VAULT: vault } });
    const r = await ctx.req('POST', '/api/memory/remember', { text: 'Backups go to Backblaze B2, not S3', source: 'Ask' });
    expect(r.json).toMatchObject({ saved: 'Inbox.md', status: 'applied' });
    expect(readFileSync(join(vault, 'Inbox.md'), 'utf8')).toContain('(Ask): Backups go to Backblaze B2, not S3');
  });
});

describe('routing for conversations', () => {
  const win = (usedPercent: number) => ({ usedPercent, resetsAt: null, source: 'test', estimate: false, tokens: null, ts: '2026-11-02T08:00:00.000Z' });
  const base = { agent_pref: 'auto' as const, schedule_id: null, effort: 'low' as const, outward: 0 };
  const cfg = { defaults: { code: 'claude', write: 'claude', research: 'codex', admin: 'codex', update: 'codex', memory: 'codex', other: 'codex' }, effortOverride: { high: 'claude' }, scheduledTasks: 'codex', chat: 'headroom', fallbackAtPercent: 85 } as const;

  it('sends a plain question to the plan with more room, and real work by type', () => {
    const usage = { claude: { five_hour: win(80), weekly: win(20) }, codex: { five_hour: win(10), weekly: win(5) } };
    expect(decide({ ...base, type: 'other', mode: 'chat' }, usage, cfg).agent).toBe('codex');
    expect(decide({ ...base, type: 'code', mode: 'chat' }, usage, cfg).agent).toBe('claude');
    expect(decide({ ...base, type: 'other', mode: 'task' }, usage, cfg).agent).toBe('codex');
    expect(decide({ ...base, type: 'other', mode: 'chat' }, usage, { ...cfg, chat: 'claude' })).toMatchObject({ agent: 'claude', reason: 'questions → claude' });
  });

  it('treats unknown usage as half full and breaks ties toward Claude', () => {
    const none = { claude: { five_hour: null, weekly: null }, codex: { five_hour: null, weekly: null } };
    expect(headroomPick(none)).toMatchObject({ agent: 'claude', reason: 'question → claude (more room: Claude unknown, Codex unknown)' });
    expect(headroomPick({ ...none, codex: { five_hour: win(30), weekly: null } }).agent).toBe('codex');
  });
});

describe('live activity lines', () => {
  it('names the real file, command, query or note', () => {
    expect(activityLine('Read', { file_path: 'C:\\repo\\server\\src\\auth.ts' })).toBe('Reading src/auth.ts');
    expect(activityLine('Bash', { command: 'npm test' })).toBe('Running npm test');
    expect(activityLine('shell', { command: 'git status' })).toBe('Running git status');
    expect(activityLine('WebSearch', { query: 'postgres backup tools' })).toBe('Searching the web for “postgres backup tools”');
    expect(activityLine('web_search', { query: 'x' })).toBe('Searching the web for “x”');
    expect(activityLine('WebFetch', { url: 'https://www.example.com/docs' })).toBe('Opening example.com');
    expect(activityLine('mcp__jarvis__search_memory', { query: 'ClientEasy' })).toBe('Checking your notes for “ClientEasy”');
    expect(activityLine('mcp__jarvis__read_note', { path: 'Projects/ClientEasy.md' })).toBe('Reading your note Projects/ClientEasy.md');
    expect(activityLine('mcp__github__create_issue', {})).toBe('Using github: create issue');
    expect(activityLine('Grep', { pattern: 'refreshToken' })).toBe('Searching the code for “refreshToken”');
  });
});

describe('attachments reach the agents the way each one takes them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-att-'));
  const img = join(dir, 'a.png');
  const pdf = join(dir, 'b.pdf');
  writeFileSync(img, Buffer.from([1, 2, 3]));
  writeFileSync(pdf, Buffer.from('%PDF-1.4'));
  const input = (attachments: RunInput['attachments']): RunInput => ({ taskId: 't', runId: 'r', prompt: 'Look', contextPrefix: '', cwd: dir, sandbox: 'read-only', allowNetwork: false, taskType: 'other', attachments });

  it('Claude gets images and PDFs as content blocks; other files as paths', async () => {
    const p = buildClaudePrompt(input([
      { id: 'u1', name: 'a.png', mime: 'image/png', size: 3, path: img },
      { id: 'u2', name: 'b.pdf', mime: 'application/pdf', size: 8, path: pdf },
      { id: 'u3', name: 'c.docx', mime: 'application/msword', size: 9, path: join(dir, 'c.docx') },
    ]));
    expect(typeof p).not.toBe('string');
    const messages = [];
    for await (const m of p as AsyncIterable<{ message: { content: Array<{ type: string; text?: string; source?: { data: string } }> } }>) messages.push(m);
    const content = messages[0].message.content;
    expect(content.map((b) => b.type)).toEqual(['text', 'image', 'document']);
    expect(content[1].source?.data).toBe(Buffer.from([1, 2, 3]).toString('base64'));
    expect(content[0].text).toContain('c.docx (application/msword');
    expect(buildClaudePrompt(input(undefined))).toBe('Look');
  });

  it('Codex gets images as local_image and everything else as paths', () => {
    const p = buildCodexInput('Look', input([
      { id: 'u1', name: 'a.png', mime: 'image/png', size: 3, path: img },
      { id: 'u2', name: 'b.pdf', mime: 'application/pdf', size: 8, path: pdf },
    ]));
    expect(Array.isArray(p)).toBe(true);
    expect((p as Array<{ type: string }>).map((x) => x.type)).toEqual(['text', 'local_image']);
    expect((p as Array<{ text?: string }>)[0].text).toContain('b.pdf');
  });
});

describe('agent status', () => {
  it('reports both agents with models in mock mode and records real Claude usage from a probe', async () => {
    ctx = makeCtx();
    const st = (await ctx.req('GET', '/api/agents')).json.agents;
    expect(st.claude).toMatchObject({ state: 'ready', signedIn: true, defaultModel: 'default' });
    expect(st.claude.models.map((m: { value: string }) => m.value)).toContain('sonnet');
    expect(st.codex.models.length).toBeGreaterThan(0);
    const svc = new AgentsService(ctx.s);
    svc.apply({ errors: [], usage: { five_hour: { utilization: 69, resets_at: new Date(Date.now() + 3600_000).toISOString() }, weekly: { utilization: 16, resets_at: null }, subscription: 'pro' } });
    expect(ctx.s.usage.current().claude.five_hour).toMatchObject({ usedPercent: 69, source: 'claude-usage' });
    expect(ctx.s.usage.current().claude.weekly?.usedPercent).toBe(16);
  });

  it('shows Claude as signed out after an expired sign-in until a run works again', async () => {
    ctx = makeCtx();
    const t = ctx.s.tasks.create({ title: 'x', run: false });
    ctx.s.db.prepare("INSERT INTO runs (id, task_id, agent, cwd, started_at, status, error) VALUES ('r1', ?, 'claude', '/tmp', ?, 'failed', 'Failed to authenticate: OAuth session expired and could not be refreshed')").run(t.id, new Date().toISOString());
    expect((await ctx.req('GET', '/api/agents')).json.agents.claude).toMatchObject({ state: 'signed_out', detail: 'Sign-in expired' });
    ctx.s.db.prepare("INSERT INTO runs (id, task_id, agent, cwd, started_at, status) VALUES ('r2', ?, 'claude', '/tmp', ?, 'done')").run(t.id, new Date(Date.now() + 1000).toISOString());
    expect((await ctx.req('GET', '/api/agents')).json.agents.claude.state).toBe('ready');
  });
});
