import type { MiddlewareHandler } from 'hono';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function hostnameOf(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Without an access token the API is protected only by listening on loopback, which a web page
 * open in the owner's browser can still reach. Refuse requests whose Host is not a loopback name
 * (DNS rebinding) and state-changing requests sent cross-site by a browser (CSRF). With a token
 * configured the token itself does this job, so remote access over Tailscale is not affected.
 */
export function localOriginGuard(accessToken: string | null): MiddlewareHandler {
  return async (c, next) => {
    if (accessToken) return next();
    const host = hostnameOf(c.req.url);
    if (!host || !LOOPBACK.has(host)) {
      return c.json({ error: 'forbidden', message: `Jarvis only answers on 127.0.0.1 or localhost without an access token (got host "${host ?? '?'}").` }, 403);
    }
    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header('origin');
      const site = c.req.header('sec-fetch-site');
      if ((origin !== undefined && origin !== new URL(c.req.url).origin) || site === 'cross-site') {
        return c.json({ error: 'forbidden', message: 'Cross-site requests to Jarvis are refused.' }, 403);
      }
    }
    return next();
  };
}
