import type { Hono } from 'hono';
import type { Services } from '../app.ts';
import { all } from '../db/index.ts';
import { collabOf } from '../collab/index.ts';
import type { HandoffSpec } from '../collab/index.ts';
import { bad, body } from './core.ts';

export function registerCollabRoutes(app: Hono, s: Services): void {
  app.post('/api/tasks/:id/handoff', async (c) => {
    const b = await body<Partial<HandoffSpec>>(c);
    const spec: HandoffSpec = {
      agent: b.agent === 'claude' || b.agent === 'codex' ? b.agent : 'other',
      mode: b.mode === 'continue' ? 'continue' : 'review',
      instructions: typeof b.instructions === 'string' ? b.instructions.slice(0, 4000) : undefined,
    };
    try {
      const r = collabOf(s).request(c.req.param('id'), spec);
      return c.json({ mode: r.mode, task: r.task ?? null });
    } catch (err) {
      const msg = (err as Error).message;
      return bad(c, msg === 'not_found' ? 'No task with that id.' : msg, msg === 'not_found' ? 404 : 400);
    }
  });

  app.delete('/api/tasks/:id/handoff', (c) => {
    if (!s.tasks.get(c.req.param('id'))) return bad(c, 'No task with that id.', 404);
    s.tasks.patch(c.req.param('id'), { then_json: null });
    return c.json({ ok: true });
  });

  /** Linked tasks: where this one came from and what it handed off to. */
  app.get('/api/tasks/:id/links', (c) => {
    const t = s.tasks.get(c.req.param('id'));
    if (!t) return bad(c, 'No task with that id.', 404);
    const parent = t.parent_id ? s.tasks.get(t.parent_id) ?? null : null;
    const children = all(s.db, 'SELECT id, title, status, agent, agent_pref, handoff_json FROM tasks WHERE parent_id = ? ORDER BY created_at', t.id);
    const consults = all(s.db, "SELECT id, agent, status, started_at, route_reason FROM runs WHERE task_id = ? AND route_reason LIKE 'consult:%' ORDER BY started_at", t.id);
    return c.json({ parent, children, consults, then: t.then_json ? JSON.parse(t.then_json) : null, origin: t.handoff_json ? JSON.parse(t.handoff_json) : null, consultsLeft: Math.max(0, s.config.get().collaboration.maxConsultsPerTask - consults.length) });
  });
}
