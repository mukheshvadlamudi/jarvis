import type { Hono } from 'hono';
import type { Services } from '../app.ts';
import { schedulerOf } from '../scheduler/module.ts';
import type { TaskTemplate } from '../scheduler/routines.ts';
import { BUILT_INS, dueFollowUps } from '../scheduler/routines.ts';
import { nextRuns, PRESETS, validateCron } from '../scheduler/service.ts';
import { cronFromWords } from '../scheduler/words.ts';
import { bad, body } from './core.ts';

export function registerScheduleRoutes(app: Hono, s: Services): void {
  const sch = () => schedulerOf(s);
  const shape = (x: ReturnType<ReturnType<typeof sch>['list']>[number]) => ({
    ...x,
    template: JSON.parse(x.task_template_json) as TaskTemplate,
    upcoming: x.enabled ? nextRuns(x.cron, 3) : [],
    lastRun: sch().history(x.id, 1)[0] ?? null,
  });

  app.get('/api/schedules', (c) => c.json({ schedules: sch().list().map(shape), presets: PRESETS, builtIns: BUILT_INS.map((b) => b.key) }));
  app.get('/api/schedules/history', (c) => c.json({ runs: sch().history(c.req.query('id') || undefined, Number(c.req.query('limit') ?? 50)) }));

  app.get('/api/schedules/today', (c) => {
    const now = new Date();
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    const items = sch()
      .list()
      .filter((x) => x.enabled)
      .flatMap((x) => nextRuns(x.cron, 6, now).filter((t) => Date.parse(t) <= end.getTime()).map((t) => ({ id: x.id, name: x.name, at: t })))
      .sort((a, b) => a.at.localeCompare(b.at));
    const ranToday = sch()
      .history(undefined, 40)
      .filter((r) => new Date(r.ts).toDateString() === now.toDateString() && r.kind !== 'skipped');
    return c.json({ upcoming: items, ranToday, followUps: dueFollowUps(s, now, 7) });
  });

  app.post('/api/schedules/validate', async (c) => {
    const b = await body<{ cron?: string }>(c);
    const error = validateCron(b.cron ?? '');
    return c.json({ ok: !error, error, upcoming: error ? [] : nextRuns(b.cron!, 3) });
  });

  app.post('/api/schedules/parse', async (c) => {
    const b = await body<{ text?: string }>(c);
    if (!b.text?.trim()) return bad(c, 'Describe when it should run, e.g. “weekdays at 8:30”.');
    const r = await cronFromWords(b.text, s.runners, s.env.dataDir);
    return c.json({ ...r, upcoming: r.cron ? nextRuns(r.cron, 3) : [] });
  });

  app.post('/api/schedules', async (c) => {
    const b = await body<{ name?: string; cron?: string; template?: TaskTemplate; enabled?: boolean; description?: string }>(c);
    try {
      const x = sch().create({ name: b.name ?? '', cron: b.cron ?? '', template: b.template ?? { title: '' }, enabled: b.enabled, description: b.description });
      return c.json({ schedule: shape(x) }, 201);
    } catch (err) {
      return bad(c, (err as Error).message);
    }
  });

  app.patch('/api/schedules/:id', async (c) => {
    const b = await body<{ name?: string; cron?: string; template?: TaskTemplate; enabled?: boolean; description?: string }>(c);
    try {
      return c.json({ schedule: shape(sch().update(c.req.param('id'), b)) });
    } catch (err) {
      const msg = (err as Error).message;
      return bad(c, msg === 'not_found' ? 'No schedule with that id.' : msg, msg === 'not_found' ? 404 : 400);
    }
  });

  app.delete('/api/schedules/:id', (c) => {
    try {
      return sch().delete(c.req.param('id')) ? c.json({ ok: true }) : bad(c, 'No schedule with that id.', 404);
    } catch (err) {
      return bad(c, (err as Error).message, 409);
    }
  });

  app.post('/api/schedules/:id/run-now', async (c) => {
    const t = await sch().fire(c.req.param('id'), 'manual');
    return t ? c.json({ task: t }) : bad(c, 'No schedule with that id.', 404);
  });
}
