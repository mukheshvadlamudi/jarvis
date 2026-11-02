import type { Handler } from 'hono';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { extname, join, normalize, resolve } from 'node:path';

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
    const headers: Record<string, string> = {
      'content-type': type,
      'content-length': String(statSync(file).size),
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    // Cross-origin isolation lets the on-device voice models use multi-threaded WASM (3–4× faster).
    // (workers need it on their own script response too, so it goes on every static file).
    Object.assign(headers, ISOLATION);
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers });
  };
}
