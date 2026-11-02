import { createReadStream, statSync } from 'node:fs';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import type { Hono } from 'hono';
import type { Services } from '../app.ts';
import { kindOf, mimeOf, Outputs } from '../workspaces/outputs.ts';
import { bad, body } from './core.ts';

export function registerOutputRoutes(app: Hono, s: Services): void {
  const outputs = new Outputs(s);
  s.modules.outputs = outputs;

  app.get('/api/tasks/:id/outputs', async (c) => {
    if (!s.tasks.get(c.req.param('id'))) return bad(c, 'No task with that id.', 404);
    return c.json(await outputs.list(c.req.param('id')));
  });

  /** Raw file. Agent-written HTML/SVG is sandboxed so it can never script this origin. */
  app.get('/api/tasks/:id/outputs/raw', (c) => {
    let abs: string;
    try {
      abs = outputs.resolve(c.req.param('id'), Number(c.req.query('folder') ?? 0), c.req.query('path') ?? '');
    } catch (err) {
      const msg = (err as Error).message;
      return bad(c, msg === 'not_found' ? 'That file is no longer there.' : msg, msg === 'not_found' ? 404 : 400);
    }
    const name = basename(abs);
    const kind = kindOf(name);
    const headers: Record<string, string> = {
      'content-type': mimeOf(name),
      'content-length': String(statSync(abs).size),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      // Embeddable in the cross-origin-isolated app.
      'cross-origin-resource-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
      'content-security-policy': "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; media-src 'self'",
    };
    if (c.req.query('download') === '1' || kind === 'office' || kind === 'archive' || kind === 'binary') headers['content-disposition'] = `attachment; filename="${name.replace(/"/g, '')}"`;
    return new Response(Readable.toWeb(createReadStream(abs)) as ReadableStream, { headers });
  });

  app.post('/api/tasks/:id/outputs/save', async (c) => {
    const b = await body<{ folder?: number; path?: string; target?: string }>(c);
    try {
      const target = outputs.saveToVault(c.req.param('id'), Number(b.folder ?? 0), b.path ?? '', b.target);
      return c.json({ saved: target });
    } catch (err) {
      const msg = (err as Error).message;
      return bad(c, msg === 'not_found' ? 'That file is no longer there.' : msg, msg === 'not_found' ? 404 : 400);
    }
  });
}
