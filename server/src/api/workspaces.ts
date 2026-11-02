import type { Hono } from 'hono';
import type { Services } from '../app.ts';
import { all } from '../db/index.ts';
import { memoryOf } from '../memory/module.ts';
import { listPeople, touchPerson } from '../workspaces/people.ts';
import { workspacesOf } from '../workspaces/module.ts';
import { bad, body } from './core.ts';

export function registerWorkspaceRoutes(app: Hono, s: Services): void {
  const w = () => workspacesOf(s);

  // ---- Research ----
  app.get('/api/research', (c) => {
    const q = c.req.query('q')?.trim();
    const { vault } = memoryOf(s);
    const rows = all<{ path: string; title: string; updated: string | null; project: string | null; tokens: number; frontmatter_json: string | null; mtime: number }>(
      s.db,
      "SELECT path, title, updated, project, tokens, frontmatter_json, mtime FROM notes_index WHERE path LIKE 'Research/%' ORDER BY path DESC",
    );
    const hits = q ? new Map(vault.search(q, { limit: 100, type: 'research' }).map((h) => [h.path, h.snippet])) : null;
    const reports = rows
      .filter((r) => !hits || hits.has(r.path))
      .map((r) => {
        const fm = JSON.parse(r.frontmatter_json ?? '{}') as { task?: string; agent?: string; tags?: unknown };
        const task = fm.task ? s.tasks.get(String(fm.task)) : undefined;
        return { path: r.path, title: r.title, updated: r.updated ?? new Date(r.mtime).toISOString().slice(0, 10), project: r.project, tokens: r.tokens, task: task ? { id: task.id, status: task.status } : null, agent: fm.agent ?? null, snippet: hits?.get(r.path) ?? null };
      });
    const running = s.tasks.list({ status: 'queued,running,needs_you', type: 'research' });
    return c.json({ reports, running });
  });

  // ---- Feeds ----
  app.get('/api/feeds', (c) => c.json({ sources: w().feeds.sources(), autoFetch: s.env.runner === 'real' || process.env.JARVIS_FEEDS_FETCH === '1', everyHours: s.config.get().feeds.fetchEveryHours }));
  app.post('/api/feeds', async (c) => {
    const b = await body<{ url?: string; name?: string }>(c);
    if (!b.url) return bad(c, 'Paste the feed or page URL.');
    try {
      return c.json({ source: await w().feeds.add({ url: b.url, name: b.name }) }, 201);
    } catch (err) {
      return bad(c, (err as Error).message);
    }
  });
  app.patch('/api/feeds/:id', async (c) => {
    const b = await body<{ enabled?: boolean; name?: string }>(c);
    const src = w().feeds.source(c.req.param('id'));
    if (!src) return bad(c, 'No feed with that id.', 404);
    s.db.prepare('UPDATE feed_sources SET enabled = ?, name = ? WHERE id = ?').run(b.enabled === undefined ? src.enabled : b.enabled ? 1 : 0, b.name?.trim() || src.name, src.id);
    return c.json({ source: w().feeds.source(src.id) });
  });
  app.delete('/api/feeds/:id', (c) => {
    const r = s.db.prepare('DELETE FROM feed_sources WHERE id = ?').run(c.req.param('id'));
    return r.changes ? c.json({ ok: true }) : bad(c, 'No feed with that id.', 404);
  });
  app.post('/api/feeds/fetch', async (c) => c.json(await w().feeds.fetchAll()));
  app.post('/api/feeds/:id/fetch', async (c) => {
    try {
      return c.json(await w().feeds.fetchOne(c.req.param('id')));
    } catch {
      return bad(c, 'No feed with that id.', 404);
    }
  });
  app.get('/api/feeds/items', (c) => c.json({ items: w().feeds.items({ unseen: c.req.query('unseen') === '1', source: c.req.query('source') || undefined, limit: Number(c.req.query('limit') ?? 100) }) }));
  app.post('/api/feeds/items/seen', async (c) => {
    const b = await body<{ ids?: string[]; all?: boolean }>(c);
    const n = w().feeds.markSeen(b.all ? 'all' : b.ids ?? []);
    s.bus.publish('feed.updated', { seen: n });
    return c.json({ marked: n });
  });

  // ---- Projects (workspace view) ----
  app.get('/api/projects/overview', async (c) => c.json({ projects: await w().projects.list() }));
  app.post('/api/projects/:id/worktrees/:task/pr', async (c) => {
    try {
      return c.json({ approval: await w().projects.requestPr(c.req.param('id'), c.req.param('task')) }, 201);
    } catch (err) {
      return bad(c, (err as Error).message);
    }
  });
  app.delete('/api/projects/:id/worktrees/:task', async (c) => {
    try {
      await w().projects.cleanup(c.req.param('id'), c.req.param('task'), c.req.query('force') === '1');
      return c.json({ ok: true });
    } catch (err) {
      return bad(c, (err as Error).message, 409);
    }
  });

  // ---- People ----
  app.get('/api/people', (c) => c.json({ people: listPeople(s) }));
  app.post('/api/people/touch', async (c) => {
    const b = await body<{ path?: string; contacted?: boolean; followUp?: string | null }>(c);
    if (!b.path) return bad(c, 'path is required');
    try {
      touchPerson(s, b.path, { contacted: b.contacted, followUp: b.followUp });
      return c.json({ person: listPeople(s).find((p) => p.path === b.path) ?? null });
    } catch (err) {
      return bad(c, (err as Error).message);
    }
  });

  // ---- Telegram status ----
  app.get('/api/telegram', (c) => c.json({ configured: !!(s.env.telegramToken && s.env.telegramChatId), enabled: s.config.get().telegram.enabled, running: !!s.modules.telegram }));
}
