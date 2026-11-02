import type { MiddlewareHandler } from 'hono';
import { timingSafeEqual } from 'node:crypto';

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * When an access token is configured, every API request must carry it: `Authorization: Bearer`,
 * or `?token=` for EventSource, which cannot set headers. Health stays open for uptime checks.
 */
export function authMiddleware(token: string | null): MiddlewareHandler {
  return async (c, next) => {
    // /api/mcp/call authenticates with its own per-run token.
    if (!token || c.req.path === '/api/health' || c.req.path === '/api/mcp/call') return next();
    const header = c.req.header('authorization');
    const supplied = header?.startsWith('Bearer ') ? header.slice(7) : c.req.query('token') ?? '';
    if (!supplied || !same(supplied, token)) {
      return c.json({ error: 'unauthorized', message: 'This Jarvis needs its access token. Enter it in the sign-in screen.' }, 401);
    }
    return next();
  };
}
