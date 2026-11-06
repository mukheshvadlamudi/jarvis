import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Services } from '../app.ts';
import { all, get, run } from '../db/index.ts';
import { decide } from '../router/index.ts';
import type { AgentPref, Effort, Project, Task, TaskStatus, TaskType } from '../types.ts';
import { TASK_STATUSES } from '../types.ts';
import { dailyTokens, routingLog, tokensByType } from '../usage/summary.ts';
import { newId, nowIso } from '../util/ids.ts';
import { presentBillingKeys } from '../util/env.ts';

export async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return {} as T;
  }
}

export function bad(c: Context, message: string, status: 400 | 404 | 409 = 400) {
  return c.json({ error: status === 404 ? 'not_found' : 'bad_request', message }, status);
}

function withDetail(rows: Array<Record<string, unknown>>, s: Services) {
  return rows.map((a) => ({ ...a, detail: JSON.parse(String(a.detail_json ?? '{}')), live: s.approvals.hasWaiter(String(a.id)) }));
}

let streamEpoch = Date.now();

export function registerCoreRoutes(app: Hono, s: Services): void {
  const started = Date.now();

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      runner: s.env.runner,
      demo: s.env.demo,
      uptimeSec: Math.round((Date.now() - started) / 1000),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      activeRuns: s.orchestrator.activeCount(),
      billingKeysPresent: presentBillingKeys(),
      remoteAccess: s.env.accessToken !== null && s.env.bind !== '127.0.0.1',
    }),
  );

  app.get('/api/stream', (c) =>
    streamSSE(c, async (stream) => {
      const epoch = ++streamEpoch;
      let id = 0;
      const queue: Array<{ type: string; data: unknown }> = [];
      let wake: (() => void) | null = null;
      const unsubscribe = s.bus.subscribe((e) => {
        if (e.type.startsWith('run.') && (e.data as { visibility?: string } | null)?.visibility === 'internal') return;
        if (queue.length > 500) queue.shift(); // slow client: drop oldest rather than grow unbounded
        queue.push(e);
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ epoch, active: s.orchestrator.activeRuns().filter((r) => r.visibility !== 'internal'), ts: nowIso(), counts: s.tasks.counts(), approvals: s.approvals.pendingCount() }), id: String(id++) });
      while (!stream.aborted) {
        if (!queue.length) {
          await Promise.race([new Promise<void>((r) => (wake = r)), stream.sleep(25_000)]);
          wake = null;
          if (!queue.length && !stream.aborted) {
            await stream.writeSSE({ event: 'ping', data: '{}' });
            continue;
          }
        }
        const e = queue.shift();
        if (e) await stream.writeSSE({ event: e.type, data: JSON.stringify(e.data), id: String(id++) });
      }
      unsubscribe();
    }),
  );

  // ---- Tasks ---------------------------------------------------------------------------------
  app.get('/api/tasks', (c) => {
    const q = c.req.query();
    return c.json({ tasks: s.tasks.list({ status: q.status, type: q.type, project: q.project, agent: q.agent, q: q.q, mode: q.mode, limit: q.limit ? Number(q.limit) : undefined }), counts: s.tasks.counts() });
  });

  app.post('/api/tasks/preview', async (c) => {
    const b = await body<{ text?: string; agent_pref?: AgentPref; mode?: 'chat' | 'task' }>(c);
    const text = (b.text ?? '').trim();
    if (!text) return c.json({ type: 'other', project: null, effort: 'medium', agent: null, reason: null, outward: false });
    const cls = s.tasks.preview(text);
    const project = cls.projectId ? get<Project>(s.db, 'SELECT id, name, kind FROM projects WHERE id = ?', cls.projectId) : null;
    const route = decide(
      { agent_pref: b.agent_pref ?? 'auto', schedule_id: null, effort: cls.effort, type: cls.type, outward: cls.outward ? 1 : 0, mode: b.mode === 'chat' ? 'chat' : 'task', title: text.split('\n')[0] },
      s.usage.current(),
      s.config.get().router,
    );
    return c.json({ type: cls.type, project, effort: cls.effort, outward: cls.outward, agent: route.agent, reason: route.reason, holdUntil: route.holdUntil ?? null });
  });

  app.post('/api/tasks', async (c) => {
    const b = await body<{
      title?: string; body?: string; type?: TaskType; priority?: number; project_id?: string | null; agent_pref?: AgentPref;
      effort?: Effort; due_at?: string | null; run?: boolean; outward?: boolean; parent_id?: string | null;
    }>(c);
    if (!b.title || !b.title.trim()) return bad(c, 'Give the task a title (one line describing what to do).');
    const t = s.tasks.create({
      title: b.title, body: b.body, type: b.type, priority: b.priority, project_id: b.project_id, agent_pref: b.agent_pref,
      effort: b.effort, due_at: b.due_at, run: b.run, outward: b.outward, parent_id: b.parent_id,
    });
    if (t.status === 'queued') s.orchestrator.tick();
    return c.json({ task: s.tasks.get(t.id) }, 201);
  });

  app.get('/api/tasks/:id', (c) => {
    const t = s.tasks.get(c.req.param('id'));
    if (!t) return bad(c, 'No task with that id. It may have been deleted.', 404);
    const runs = s.orchestrator.runsForTask(t.id);
    const approvals = withDetail(all(s.db, 'SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at DESC', t.id), s);
    const project = t.project_id ? get<Project>(s.db, 'SELECT * FROM projects WHERE id = ?', t.project_id) : null;
    return c.json({ task: t, runs, approvals, project, active: s.orchestrator.isActive(t.id) });
  });

  app.patch('/api/tasks/:id', async (c) => {
    const id = c.req.param('id');
    const b = await body<Record<string, unknown> & { status?: TaskStatus }>(c);
    if (!s.tasks.get(id)) return bad(c, 'No task with that id.', 404);
    const { status, ...fields } = b;
    if (Object.keys(fields).length) s.tasks.patch(id, fields);
    if (status) {
      if (!TASK_STATUSES.includes(status)) return bad(c, `Unknown status "${status}".`);
      if (status === 'cancelled') await s.orchestrator.cancel(id);
      else if (status === 'queued') s.orchestrator.enqueue(id);
      else s.tasks.move(id, status);
    }
    return c.json({ task: s.tasks.get(id) });
  });

  app.delete('/api/tasks/:id', async (c) => {
    const id = c.req.param('id');
    if (s.orchestrator.isActive(id)) await s.orchestrator.cancel(id);
    return s.tasks.delete(id) ? c.json({ ok: true }) : bad(c, 'No task with that id.', 404);
  });

  app.post('/api/tasks/:id/run', async (c) => {
    const id = c.req.param('id');
    const b = await body<{ agent?: AgentPref }>(c);
    const t = s.tasks.get(id);
    if (!t) return bad(c, 'No task with that id.', 404);
    if (s.orchestrator.isActive(id)) return bad(c, 'This task is already running.', 409);
    if (b.agent && ['auto', 'claude', 'codex'].includes(b.agent)) s.tasks.patch(id, { agent_pref: b.agent });
    return c.json({ task: s.orchestrator.enqueue(id) });
  });

  app.post('/api/tasks/:id/cancel', async (c) => {
    const id = c.req.param('id');
    if (!s.tasks.get(id)) return bad(c, 'No task with that id.', 404);
    return c.json({ task: await s.orchestrator.cancel(id) });
  });

  app.post('/api/tasks/:id/followup', async (c) => {
    const id = c.req.param('id');
    const b = await body<{ text?: string }>(c);
    if (!b.text?.trim()) return bad(c, 'Write the follow-up message first.');
    if (!s.tasks.get(id)) return bad(c, 'No task with that id.', 404);
    const r = await s.orchestrator.followUp(id, b.text.trim());
    return c.json({ ...r, task: s.tasks.get(id) });
  });

  // ---- Runs ----------------------------------------------------------------------------------
  app.get('/api/runs', (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);
    const rows = all(s.db, `SELECT r.*, t.title, t.type FROM runs r JOIN tasks t ON t.id = r.task_id ORDER BY r.started_at DESC LIMIT ?`, limit);
    return c.json({ runs: rows, active: s.orchestrator.activeRuns() });
  });

  app.get('/api/runs/:id', (c) => {
    const r = s.orchestrator.getRun(c.req.param('id'));
    if (!r) return bad(c, 'No run with that id.', 404);
    const task = s.tasks.get(r.task_id);
    const approvals = withDetail(all(s.db, 'SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at', r.id), s);
    return c.json({ run: { ...r, context_report: r.context_report_json ? JSON.parse(r.context_report_json) : null }, task, approvals, live: s.orchestrator.isActive(r.task_id) && r.status === 'running' });
  });

  app.get('/api/runs/:id/events', (c) => {
    const after = Number(c.req.query('after') ?? 0);
    const limit = Number(c.req.query('limit') ?? 500);
    const events = s.orchestrator.events(c.req.param('id'), after, limit).map((e) => ({ ...e, payload: JSON.parse(e.payload_json), payload_json: undefined }));
    return c.json({ events, last: events.at(-1)?.id ?? after });
  });

  // ---- Approvals -----------------------------------------------------------------------------
  app.get('/api/approvals', (c) => {
    const status = c.req.query('status');
    const rows = all<Record<string, unknown>>(
      s.db,
      `SELECT a.*, t.title AS task_title, t.agent AS task_agent FROM approvals a LEFT JOIN tasks t ON t.id = a.task_id
       ${status ? 'WHERE a.status = ?' : ''} ORDER BY CASE a.status WHEN 'pending' THEN 0 ELSE 1 END, a.created_at DESC LIMIT 200`,
      ...(status ? [status] : []),
    ).map((a) => ({ ...a, detail: JSON.parse(String(a.detail_json ?? '{}')), live: s.approvals.hasWaiter(String(a.id)) }));
    return c.json({ approvals: rows, pending: s.approvals.pendingCount() });
  });

  app.post('/api/approvals/:id', async (c) => {
    const b = await body<{ decision?: string; note?: string; via?: string }>(c);
    if (b.decision !== 'approved' && b.decision !== 'rejected') return bad(c, 'decision must be "approved" or "rejected".');
    const r = s.approvals.decide(c.req.param('id'), b.decision, b.note?.trim() || null, b.via === 'telegram' ? 'telegram' : 'web');
    if ('error' in r) return bad(c, r.error === 'not_found' ? 'No approval with that id.' : `This approval is ${r.error.replace('already ', 'already ')}.`, r.error === 'not_found' ? 404 : 409);
    return c.json({ approval: r });
  });

  // ---- Usage ---------------------------------------------------------------------------------
  app.get('/api/usage', (c) => {
    const days = Math.min(Number(c.req.query('days') ?? 14), 60);
    const since = new Date(Date.now() - 7 * 86400_000).toISOString();
    return c.json({
      current: s.usage.current(),
      fallbackAtPercent: s.config.get().router.fallbackAtPercent,
      daily: dailyTokens(s.db, days),
      byType: tokensByType(s.db, days),
      routing: routingLog(s.db),
      history: {
        claude: s.usage.history('claude', 'five_hour', since),
        codex: s.usage.history('codex', 'five_hour', since),
      },
      totals: get(s.db, `SELECT COUNT(*) AS runs, COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens, COALESCE(SUM(tool_calls), 0) AS toolCalls FROM runs WHERE started_at >= ?`, new Date(Date.now() - days * 86400_000).toISOString()),
    });
  });

  app.post('/api/usage/poll', (c) => {
    s.usage.poll();
    return c.json({ current: s.usage.current() });
  });

  // ---- Projects (basic registry; the Projects workspace extends this) -------------------------
  app.get('/api/projects', (c) => {
    const rows = all<Project & { open_tasks: number }>(
      s.db,
      `SELECT p.*, (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status NOT IN ('done','cancelled')) AS open_tasks
       FROM projects p ORDER BY p.kind, p.name`,
    );
    return c.json({ projects: rows });
  });

  app.post('/api/projects', async (c) => {
    const b = await body<Partial<Project>>(c);
    if (s.env.demo && b.path) return bad(c, 'Run npm run app to connect a local repository.', 409);
    if (!b.name?.trim()) return bad(c, 'A project needs a name.');
    if (b.kind && !['code', 'client', 'area'].includes(b.kind)) return bad(c, 'kind must be code, client or area.');
    const p: Project = { id: newId('p'), name: b.name.trim(), kind: b.kind ?? 'code', path: b.path?.trim() || null, repo: b.repo?.trim() || null, vault_note: b.vault_note?.trim() || null, created_at: nowIso() };
    run(s.db, 'INSERT INTO projects (id, name, kind, path, repo, vault_note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', p.id, p.name, p.kind, p.path, p.repo, p.vault_note, p.created_at);
    s.bus.publish('project.created', p);
    return c.json({ project: p }, 201);
  });

  app.patch('/api/projects/:id', async (c) => {
    const id = c.req.param('id');
    const cur = get<Project>(s.db, 'SELECT * FROM projects WHERE id = ?', id);
    if (!cur) return bad(c, 'No project with that id.', 404);
    const b = await body<Partial<Project>>(c);
    if (s.env.demo && b.path && b.path !== cur.path) return bad(c, 'Run npm run app to connect a local repository.', 409);
    const next = { ...cur, ...Object.fromEntries(Object.entries(b).filter(([k]) => ['name', 'kind', 'path', 'repo', 'vault_note'].includes(k))) } as Project;
    run(s.db, 'UPDATE projects SET name = ?, kind = ?, path = ?, repo = ?, vault_note = ? WHERE id = ?', next.name, next.kind, next.path, next.repo, next.vault_note, id);
    s.bus.publish('project.updated', next);
    return c.json({ project: next });
  });

  app.delete('/api/projects/:id', (c) => {
    const r = run(s.db, 'DELETE FROM projects WHERE id = ?', c.req.param('id'));
    return r.changes ? c.json({ ok: true }) : bad(c, 'No project with that id.', 404);
  });

  // ---- Settings ------------------------------------------------------------------------------
  app.get('/api/settings', (c) =>
    c.json({
      config: s.config.get(),
      env: {
        runner: s.env.runner,
        bind: s.env.bind,
        port: s.env.port,
        vault: s.env.vault,
        accessTokenSet: s.env.accessToken !== null,
        telegramConfigured: s.env.telegramToken !== null && s.env.telegramChatId !== null,
        codexHome: s.env.codexHome,
        claudeHome: s.env.claudeHome,
        billingKeysPresent: presentBillingKeys(),
      },
    }),
  );

  app.put('/api/settings', async (c) => {
    const b = await body<{ config?: unknown }>(c);
    const r = s.config.update(b.config ?? b);
    if (!r.ok) return c.json({ error: 'invalid', message: r.errors.join('; '), errors: r.errors }, 400);
    s.orchestrator.tick();
    return c.json({ config: r.config });
  });

  app.get('/api/summary', (c) => {
    const counts = s.tasks.counts();
    return c.json({ counts, approvals: s.approvals.pendingCount(), active: s.orchestrator.activeRuns() });
  });
}
