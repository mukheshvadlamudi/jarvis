import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, describe, expect, it } from 'vitest';
import { staticWeb } from '../src/api/static.ts';

describe('static web', () => {
  const temp = mkdtempSync(join(tmpdir(), 'jarvis-web-'));
  const dir = join(temp, 'dist');
  afterAll(() => rmSync(temp, { recursive: true, force: true }));
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

  it('blocks encoded traversal and linked directories outside the web root', async () => {
    const sibling = join(temp, 'dist-private');
    mkdirSync(sibling);
    writeFileSync(join(sibling, 'secret.txt'), 'private');
    symlinkSync(sibling, join(dir, 'link'), 'junction');
    expect((await app.request('/..%2fdist-private/secret.txt')).status).toBe(404);
    expect((await app.request('/link/secret.txt')).status).toBe(404);
    expect((await app.request('/%zz')).status).toBe(400);
    expect((await app.request('/api/unknown')).status).toBe(404);
  });
});
