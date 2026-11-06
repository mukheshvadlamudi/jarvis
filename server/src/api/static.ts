import type { Handler } from 'hono';
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** COOP + COEP (credentialless, so model downloads from Hugging Face still work). */
export const ISOLATION = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'credentialless' };

/** Serve the built web app with an SPA fallback to index.html. */
export function staticWeb(root: string): Handler {
  const base = resolve(root);
  const inside = (parent: string, file: string) => {
    const rel = relative(parent, file);
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  return (c) => {
    if (c.req.path.startsWith('/api/')) return c.notFound();
    let realBase: string;
    try {
      realBase = realpathSync(base);
    } catch {
      return c.html(
        '<!doctype html><meta charset="utf-8"><title>Jarvis</title><body style="font:14px system-ui;background:#0E0F11;color:#ECECEE;padding:32px">' +
          '<p>The web app is not built yet. Run <code>npm run build</code>, or use <code>npm run dev</code> and open the Vite URL it prints.</p>',
        503,
      );
    }
    let path: string;
    try {
      path = decodeURIComponent(c.req.path);
    } catch {
      return c.text('Invalid path', 400);
    }
    const requested = resolve(realBase, path.replace(/^[/\\]+/, ''));
    if (!inside(realBase, requested) || path.includes('\0')) return c.notFound();
    let file: string;
    let size: number;
    try {
      file = realpathSync(requested);
      if (!inside(realBase, file)) return c.notFound();
      if (!statSync(file).isFile()) throw new Error('Not a file');
      size = statSync(file).size;
    } catch {
      try {
        file = realpathSync(join(realBase, 'index.html'));
        const index = statSync(file);
        if (!inside(realBase, file) || !index.isFile()) return c.notFound();
        size = index.size;
      } catch {
        return c.text('The web app is not built yet. Run npm run build.', 503);
      }
    }
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    const immutable = inside(join(realBase, 'assets'), file);
    const headers: Record<string, string> = {
      'content-type': type,
      'content-length': String(size),
      'x-content-type-options': 'nosniff',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    // Cross-origin isolation lets the on-device voice models use multi-threaded WASM (3–4× faster).
    // (workers need it on their own script response too, so it goes on every static file).
    Object.assign(headers, ISOLATION);
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers });
  };
}
