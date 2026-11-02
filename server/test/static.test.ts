import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { staticWeb } from '../src/api/static.ts';

describe('static web', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-web-'));
  mkdirSync(join(dir, 'voice-runtime', 'ort'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>J</title>');
  writeFileSync(join(dir, 'voice-runtime', 'ort', 'x.wasm'), Buffer.from([0, 97, 115, 109]));
  writeFileSync(join(dir, 'voice-runtime', 'ort', 'x.mjs'), 'export {}');
  const app = new Hono();
  app.get('*', staticWeb(dir));

  it('serves the app cross-origin isolated so on-device voice can use threads', async () => {
    const r = await app.request('/tasks/t_1');
    expect(r.status).toBe(200);
    expect(r.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(r.headers.get('cross-origin-embedder-policy')).toBe('credentialless');
    expect(await r.text()).toContain('<title>J</title>');
  });

  it('serves wasm and module files with the right types', async () => {
    expect((await app.request('/voice-runtime/ort/x.wasm')).headers.get('content-type')).toBe('application/wasm');
    expect((await app.request('/voice-runtime/ort/x.mjs')).headers.get('content-type')).toContain('text/javascript');
  });
});
