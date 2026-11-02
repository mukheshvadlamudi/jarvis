import type { Handler } from 'hono';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Serve the built web app with an SPA fallback to index.html. */
export function staticWeb(root: string): Handler {
  const base = resolve(root);
  return (c) => {
    if (!existsSync(base)) {
      return c.html(
        '<!doctype html><meta charset="utf-8"><title>Jarvis</title><body style="font:14px system-ui;background:#0E0F11;color:#ECECEE;padding:32px">' +
          '<p>The web app is not built yet. Run <code>npm run build</code>, or use <code>npm run dev</code> and open the Vite URL it prints.</p>',
        503,
      );
    }
    const rel = normalize(decodeURIComponent(c.req.path)).replace(/^([/\\])+/, '');
    let file = join(base, rel);
    if (!file.startsWith(base) || !existsSync(file) || statSync(file).isDirectory()) file = join(base, 'index.html');
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    const immutable = file.includes(`${join(base, 'assets')}`);
    return c.body(readFileSync(file), 200, {
      'content-type': type,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
  };
}
