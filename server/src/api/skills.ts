import type { Hono } from 'hono';
import type { Services } from '../app.ts';
import { skillsOf } from '../skills/module.ts';
import { CONNECTOR_TEMPLATES } from '../skills/registry.ts';
import { syncSkills, syncStatus } from '../skills/sync.ts';
import { bad, body } from './core.ts';

export function registerSkillsRoutes(app: Hono, s: Services): void {
  const k = () => skillsOf(s);
  const targets = () => s.env.skillsTargets;

  app.get('/api/skills', (c) => {
    const { registry, learning } = k();
    const status = syncStatus(registry, s.db, targets());
    return c.json({
      skills: registry.list().map((sk) => ({ ...sk, sync: status[sk.name] ?? null })),
      targets: targets(),
      dryRunTargets: s.env.runner === 'mock',
      pendingProposals: learning.list('pending').length,
      templates: Object.keys(CONNECTOR_TEMPLATES).map((name) => ({ name, description: CONNECTOR_TEMPLATES[name].description, exists: !!registry.get(name) })),
    });
  });

  app.post('/api/skills/sync', async (c) => {
    const b = await body<{ dryRun?: boolean }>(c);
    k().registry.scan();
    const r = syncSkills(k().registry, s.db, targets(), { dryRun: b.dryRun === true });
    s.bus.publish('skills.updated', {});
    return c.json(r);
  });

  app.get('/api/skills/proposals', (c) => c.json({ proposals: k().learning.list(c.req.query('status') || undefined) }));

  app.post('/api/skills/proposals/:id', async (c) => {
    const b = await body<{ decision?: string; name?: string; description?: string; body?: string }>(c);
    if (b.decision !== 'approved' && b.decision !== 'rejected') return bad(c, 'decision must be "approved" or "rejected".');
    try {
      const p = k().learning.decide(c.req.param('id'), b.decision, { name: b.name, description: b.description, body: b.body });
      if (b.decision === 'approved') syncSkills(k().registry, s.db, targets());
      return c.json({ proposal: p });
    } catch (err) {
      const msg = (err as Error).message;
      return bad(c, msg === 'not_found' ? 'No proposal with that id.' : msg, msg === 'not_found' ? 404 : 409);
    }
  });

  app.post('/api/skills/templates/:name', (c) => {
    const t = CONNECTOR_TEMPLATES[c.req.param('name')];
    if (!t) return bad(c, 'No template with that name.', 404);
    if (k().registry.get(c.req.param('name'))) return bad(c, 'That skill already exists in your vault.', 409);
    return c.json({ skill: k().registry.write(c.req.param('name'), t.description, t.body) }, 201);
  });

  app.get('/api/skills/:name', (c) => {
    const sk = k().registry.get(c.req.param('name'));
    if (!sk) return bad(c, 'No skill with that name.', 404);
    return c.json({ skill: sk, content: k().registry.read(sk.name) });
  });

  app.patch('/api/skills/:name', async (c) => {
    const b = await body<{ enabled?: boolean }>(c);
    if (typeof b.enabled !== 'boolean') return bad(c, 'Send {"enabled": true|false}.');
    try {
      return c.json({ skill: k().registry.setEnabled(c.req.param('name'), b.enabled) });
    } catch {
      return bad(c, 'No skill with that name.', 404);
    }
  });
}
