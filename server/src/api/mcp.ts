import type { Hono } from 'hono';
import type { Services } from '../app.ts';
import { mcpOf } from '../mcp/module.ts';
import { body } from './core.ts';

export function registerMcpRoutes(app: Hono, s: Services): void {
  app.post('/api/mcp/call', async (c) => {
    const ctx = mcpOf(s).authenticate(c.req.header('x-jarvis-run') ?? '', c.req.header('x-jarvis-mcp-token') ?? '');
    if (!ctx) return c.json({ error: 'unauthorized', message: 'Unknown or finished run.' }, 401);
    const b = await body<{ tool?: string; args?: Record<string, unknown> }>(c);
    try {
      return c.json(await mcpOf(s).call(ctx, String(b.tool ?? ''), b.args ?? {}));
    } catch (err) {
      return c.json({ text: (err as Error).message, isError: true });
    }
  });
}
