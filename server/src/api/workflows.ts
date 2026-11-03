import type { Hono } from 'hono';
import type { Services } from '../app.ts';
import { workflowsOf } from '../workflows/service.ts';
import { bad, body } from './core.ts';

export function registerWorkflowRoutes(app: Hono, s: Services) {
  const w = () => workflowsOf(s);
  app.get('/api/workflows', c => c.json({ workflows: w().list(), runs: w().recent(c.req.query('conversationId')), errors: w().loadErrors }));
  app.post('/api/workflows', async c => { try { return c.json({ workflow: w().put(await body<unknown>(c)) }); } catch (e) { return bad(c, (e as Error).message); } });
  app.delete('/api/workflows/:id', c => { try { w().delete(c.req.param('id')); return c.json({ ok: true }); } catch (e) { return bad(c, (e as Error).message); } });
  app.post('/api/workflows/:id/run', async c => {
    try { const b = await body<{ input?: unknown; conversationId?: unknown }>(c); if (b.conversationId !== undefined && typeof b.conversationId !== 'string') return bad(c, 'conversationId must be a string'); return c.json(await w().start(c.req.param('id'), b.input, b.conversationId), 201); }
    catch (e) { return bad(c, (e as Error).message); }
  });
  app.get('/api/workflow-runs/:id', c => { const result = w().get(c.req.param('id')); return result ? c.json(result) : bad(c, 'No workflow run with that id', 404); });
  app.post('/api/workflow-runs/:id/cancel', async c => { try { return c.json(await w().cancel(c.req.param('id'))); } catch (e) { return bad(c, (e as Error).message, 404); } });
}
