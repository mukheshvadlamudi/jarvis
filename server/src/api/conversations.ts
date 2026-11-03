import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Hono } from 'hono';
import type { Services } from '../app.ts';
import { agentsOf } from '../agents/service.ts';
import { all, get, run } from '../db/index.ts';
import type { MemoryModule } from '../memory/module.ts';
import type { AskOptions } from '../tasks/orchestrator.ts';
import type { AgentId, Attachment, Effort, Run, StoredRunEvent, Task } from '../types.ts';
import { newId, nowIso } from '../util/ids.ts';
import { logger } from '../util/log.ts';
import { bad, body } from './core.ts';

const log = logger('conversations');
const UPLOAD_MAX = 25 * 1024 * 1024;
const EVENTS_PER_RUN = 600;

type AgentChoice = 'auto' | 'both' | AgentId;

interface MessageBody {
  text?: string;
  agent?: AgentChoice;
  model?: string;
  effort?: Effort;
  attachments?: string[];
  project_id?: string | null;
}

const other = (a: AgentId): AgentId => (a === 'claude' ? 'codex' : 'claude');
const label = (a: string) => (a === 'claude' ? 'Claude' : a === 'codex' ? 'Codex' : a);

function askOptions(b: MessageBody): AskOptions {
  return {
    agent: b.agent === 'claude' || b.agent === 'codex' ? b.agent : undefined,
    model: typeof b.model === 'string' && /^[\w.:\-[\]]{1,80}$/.test(b.model) ? b.model : undefined,
    effort: b.effort === 'low' || b.effort === 'medium' || b.effort === 'high' ? b.effort : undefined,
    attachments: Array.isArray(b.attachments) ? b.attachments.filter((x) => typeof x === 'string').slice(0, 10) : undefined,
  };
}

/** Title for a new conversation: the first line, trimmed to a readable length. */
function titleOf(text: string): string {
  const first = text.split('\n').find((l) => l.trim())?.trim() ?? 'Conversation';
  return first.length > 90 ? `${first.slice(0, 87)}…` : first;
}

/**
 * Ask: conversations with Claude and Codex. A conversation is a task in 'chat' mode; every message
 * is one run, answered at once and streamed live (run.event + run.delta on the event stream).
 */
export function registerConversationRoutes(app: Hono, s: Services): void {
  const uploadsDir = join(s.env.dataDir, 'uploads');

  // Voice-only persistence: this never starts an agent or changes a running task's state.
  app.post('/api/conversations/:id/voice-turns', async (c) => {
    const b = await body<{ user?: unknown; assistant?: unknown }>(c);
    if (!b || typeof b.user !== 'string' || typeof b.assistant !== 'string' || !b.user.trim() || !b.assistant.trim() || b.user.length > 20000 || b.assistant.length > 20000) return bad(c, 'Send user and assistant text, each between 1 and 20000 characters.');
    const task = c.req.param('id') === 'new'
      ? s.tasks.create({ title: titleOf(b.user), mode: 'chat', run: false })
      : s.tasks.get(c.req.param('id'));
    if (!task || task.mode !== 'chat') return bad(c, 'No conversation with that id.', 404);
    const id = newId('r'); const at = nowIso();
    run(s.db, `INSERT INTO runs (id, task_id, agent, cwd, started_at, ended_at, status, purpose, visibility, owner_text, answer)
      VALUES (?, ?, 'gemini', '', ?, ?, 'done', 'user_reply', 'conversation', ?, ?)`, id, task.id, at, at, b.user.trim(), b.assistant.trim());
    run(s.db, 'UPDATE tasks SET updated_at = ? WHERE id = ?', at, task.id);
    s.bus.publish('run.finished', { id, task_id: task.id, agent: 'gemini', status: 'done', purpose: 'user_reply', visibility: 'conversation', answer: b.assistant.trim() });
    return c.json({ runId: id, conversationId: task.id }, 201);
  });

  /** "Ask both": the other agent answers the same message beside the main answer (read-only). */
  const askOther = async (task: Task, mainAgent: AgentId, text: string, b: MessageBody, withHistory: boolean) => {
    const second = other(mainAgent);
    const main = get<Run>(s.db, "SELECT * FROM runs WHERE task_id = ? AND purpose = 'user_reply' AND visibility = 'conversation' ORDER BY started_at DESC, rowid DESC LIMIT 1", task.id);
    const prompt = withHistory ? `${s.orchestrator.history(task.id)}\n\n---\n\nNew message from the owner:\n${text}` : text;
    void s.orchestrator
      .sideRun(task.id, {
        purpose: 'both', parentRunId: main?.id ?? null, agent: second, prompt, resumeSessionId: null, cwd: main?.cwd ?? join(s.env.dataDir, 'workdirs', task.id),
        label: `side:both:${label(second)} answered too`, effort: askOptions(b).effort, contextPrefix: await s.orchestrator.chatPrefix(task), webSearch: true,
        // The same files the main answer got (already copied into this folder).
        attachments: main?.attachments_json ? (JSON.parse(main.attachments_json) as Attachment[]) : undefined,
      })
      .catch((err) => log.warn('second answer failed', err));
  };

  const send = async (task: Task, text: string, b: MessageBody, first: boolean) => {
    const opts = askOptions(b);
    if (b.agent === 'both' && !opts.agent) opts.agent = 'claude';
    const r = await s.orchestrator.ask(task.id, text, opts);
    if (b.agent === 'both') {
      const main = s.orchestrator.getRun(r.runId ?? '');
      await askOther(task, (main?.agent as AgentId) ?? 'claude', text, b, !first);
    }
    return r;
  };

  // ---- Uploads (raw body, name in x-filename) -------------------------------------------------
  app.post('/api/uploads', async (c) => {
    const rawName = decodeURIComponent(c.req.header('x-filename') ?? '').trim();
    const name = basename(rawName).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);
    if (!name) return bad(c, 'Send the file name in the x-filename header.');
    const len = Number(c.req.header('content-length') ?? 0);
    if (len > UPLOAD_MAX) return bad(c, `That file is over ${UPLOAD_MAX / 1024 / 1024} MB. Share a smaller one or put it in a project folder.`);
    const buf = Buffer.from(await c.req.arrayBuffer());
    if (!buf.length) return bad(c, 'The file is empty.');
    if (buf.length > UPLOAD_MAX) return bad(c, `That file is over ${UPLOAD_MAX / 1024 / 1024} MB.`);
    const id = newId('u');
    const dir = join(uploadsDir, id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, buf);
    const mime = (c.req.header('content-type') ?? 'application/octet-stream').split(';')[0].trim().toLowerCase().slice(0, 100);
    run(s.db, 'INSERT INTO uploads (id, name, mime, size, path, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, name, mime, buf.length, path, nowIso());
    return c.json({ upload: { id, name, mime, size: buf.length } }, 201);
  });

  // ---- Conversations ----------------------------------------------------------------------------
  app.get('/api/conversations', (c) => {
    const q = c.req.query('q')?.trim();
    const limit = Math.min(Number(c.req.query('limit') ?? 40), 200);
    const tasks = all<Task>(s.db, `SELECT * FROM tasks t WHERE mode = 'chat' AND
      (? = '' OR instr(lower(title), lower(?)) > 0 OR EXISTS (
        SELECT 1 FROM runs r WHERE r.task_id = t.id AND visibility = 'conversation'
        AND purpose IN ('user_reply', 'both', 'second_opinion', 'handoff')
        AND (instr(lower(COALESCE(owner_text, '')), lower(?)) > 0 OR instr(lower(COALESCE(answer, '')), lower(?)) > 0)
      )) ORDER BY updated_at DESC LIMIT ?`, q ?? '', q ?? '', q ?? '', q ?? '', limit);
    const lastAnswer = (id: string) => get<{ answer: string | null }>(s.db, "SELECT answer FROM runs WHERE task_id = ? AND visibility = 'conversation' AND purpose IN ('user_reply', 'both', 'second_opinion', 'handoff') AND answer IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT 1", id)?.answer ?? null;
    return c.json({
      conversations: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, agent: t.agent, updated_at: t.updated_at, preview: (lastAnswer(t.id) ?? '').slice(0, 160) })),
    });
  });

  app.post('/api/conversations', async (c) => {
    const b = await body<MessageBody>(c);
    const text = b.text;
    if (!text?.trim()) return bad(c, 'Type a message first.');
    const rest = text.split('\n');
    const t = s.tasks.create({
      title: titleOf(text),
      body: rest.length > 1 ? text : '',
      mode: 'chat',
      run: false,
      agent_pref: b.agent === 'claude' || b.agent === 'codex' ? b.agent : 'auto',
      effort: askOptions(b).effort,
      project_id: b.project_id,
    });
    try {
      await send(t, text, b, true);
    } catch (err) {
      return bad(c, (err as Error).message, 409);
    }
    return c.json({ conversation: s.tasks.get(t.id) }, 201);
  });

  app.get('/api/conversations/:id', (c) => {
    const t = s.tasks.get(c.req.param('id'));
    if (!t) return bad(c, 'No conversation with that id.', 404);
    const runs = all<Run>(s.db, "SELECT * FROM runs WHERE task_id = ? AND visibility != 'internal' ORDER BY started_at, rowid", t.id).map((r) => ({
      ...r,
      events: all<StoredRunEvent>(s.db, 'SELECT * FROM run_events WHERE run_id = ? ORDER BY id LIMIT ?', r.id, EVENTS_PER_RUN).map((e) => ({ ...e, payload: JSON.parse(e.payload_json) })),
    }));
    const approvals = all<Record<string, unknown>>(s.db, "SELECT * FROM approvals WHERE task_id = ? AND status = 'pending' ORDER BY created_at", t.id).map((a) => ({
      ...a, detail: JSON.parse(String(a.detail_json ?? '{}')), live: s.approvals.hasWaiter(String(a.id)),
    }));
    return c.json({ conversation: t, runs, approvals, active: s.orchestrator.isActive(t.id, false) });
  });

  app.post('/api/conversations/:id/messages', async (c) => {
    const t = s.tasks.get(c.req.param('id'));
    if (!t) return bad(c, 'No conversation with that id.', 404);
    const b = await body<MessageBody>(c);
    const text = b.text;
    if (!text?.trim()) return bad(c, 'Type a message first.');
    try {
      const r = await send(t, text, b, false);
      return c.json({ ...r, conversation: s.tasks.get(t.id) });
    } catch (err) {
      return bad(c, (err as Error).message, 409);
    }
  });

  /** The other agent checks the latest answer (read-only) and says what is wrong or missing. */
  app.post('/api/conversations/:id/second-opinion', async (c) => {
    const t = s.tasks.get(c.req.param('id'));
    if (!t) return bad(c, 'No conversation with that id.', 404);
    const b = await body<{ runId?: string; effort?: Effort }>(c);
    const target = b.runId
      ? get<Run>(s.db, "SELECT * FROM runs WHERE id = ? AND task_id = ? AND visibility = 'conversation'", b.runId, t.id)
      : get<Run>(s.db, "SELECT * FROM runs WHERE task_id = ? AND status = 'done' AND visibility = 'conversation' AND purpose IN ('user_reply', 'both', 'second_opinion') ORDER BY started_at DESC, rowid DESC LIMIT 1", t.id);
    if (!target?.answer) return bad(c, 'There is no finished answer to check yet.', 409);
    const from = (target.agent === 'codex' ? 'codex' : 'claude') as AgentId;
    const to = other(from);
    const prompt = `${s.orchestrator.history(t.id)}\n\n---\n\nThe owner wants your second opinion on ${label(from)}'s last answer above. Check it for mistakes, gaps and risky advice. Start with a one-line verdict (agree, partly agree or disagree), then list concrete corrections, then give your own short answer only if it differs.`;
    void s.orchestrator
      .sideRun(t.id, { purpose: 'second_opinion', parentRunId: target.id, agent: to, prompt, resumeSessionId: null, cwd: target.cwd, label: `side:second opinion:${label(to)} checked ${label(from)}`, effort: b.effort, contextPrefix: await s.orchestrator.chatPrefix(t), webSearch: true })
      .catch((err) => log.warn('second opinion failed', err));
    return c.json({ ok: true, agent: to });
  });

  // ---- Memory: one tap to keep something -------------------------------------------------------
  app.post('/api/memory/remember', async (c) => {
    const mem = s.modules.memory as MemoryModule | undefined;
    if (!mem) return bad(c, 'Memory is not available.', 409);
    const b = await body<{ text?: string; source?: string }>(c);
    const text = b.text?.trim();
    if (!text) return bad(c, 'Nothing to remember.');
    const stamp = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const p = mem.proposals.propose({
      target: 'Inbox.md',
      content: `\n- ${stamp}${b.source ? ` (${b.source.slice(0, 80)})` : ''}: ${text.slice(0, 4000).replace(/\n+/g, ' ')}`,
      reason: 'Saved from Ask',
      mode: 'append',
      autoApply: true,
    });
    return c.json({ saved: p.target_path, status: p.status });
  });

  // ---- Agents: who is signed in, busy, near a limit, and which models they offer ----------------
  app.get('/api/agents', (c) => c.json({ agents: agentsOf(s).status(), threshold: s.config.get().router.fallbackAtPercent }));
  app.post('/api/agents/refresh', async (c) => {
    await agentsOf(s).refresh({ models: true });
    return c.json({ agents: agentsOf(s).status(), threshold: s.config.get().router.fallbackAtPercent });
  });
}
