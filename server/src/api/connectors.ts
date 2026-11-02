import type { Hono } from 'hono';
import type { Services } from '../app.ts';
import type { AddConnectorInput, ConnectorService } from '../connectors/service.ts';
import { bad, body } from './core.ts';

export function registerConnectorRoutes(app: Hono, s: Services): void {
  app.use('/api/connectors/*', async (c, next) => {
    if (c.req.header('x-jarvis-run') || c.req.header('x-jarvis-mcp-token')) return c.json({ error: 'forbidden', message: 'Manage connectors from the owner UI' }, 403);
    if (!s.modules.connectors) return c.json({ error: 'unavailable', message: 'Connectors are not available; restart Jarvis after connector setup' }, 503);
    return next();
  });
  app.get('/api/connectors', async (c) => c.json(await (s.modules.connectors as ConnectorService).list({ fresh: c.req.query('fresh') === '1' })));
  app.post('/api/connectors', async (c) => {
    try { return c.json({ results: await (s.modules.connectors as ConnectorService).add(await body<AddConnectorInput>(c)) }); }
    catch (err) { return bad(c, (err as Error).message); }
  });
  app.delete('/api/connectors/:agent/:name', async (c) => {
    const agent = c.req.param('agent');
    if (agent !== 'claude' && agent !== 'codex') return bad(c, 'Choose Claude or Codex');
    try { return c.json(await (s.modules.connectors as ConnectorService).remove(agent, c.req.param('name'))); }
    catch (err) { return bad(c, (err as Error).message); }
  });
}
