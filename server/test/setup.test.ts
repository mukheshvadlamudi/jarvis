import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanRepos, validateVault } from '../src/setup/checks.ts';
import { FIXTURE_VAULT, makeCtx } from './helpers.ts';
import type { TestCtx } from './helpers.ts';

let ctx: TestCtx;
afterEach(async () => ctx?.close());

describe('setup', () => {
  it('reports required and optional checks; demo vault counts as not done', async () => {
    ctx = makeCtx();
    const r = await ctx.req('GET', '/api/setup');
    const ids = r.json.checks.map((c: { id: string }) => c.id);
    expect(ids).toEqual(['node', 'git', 'keys', 'claude', 'claude-chrome', 'codex', 'vault', 'projects', 'gh', 'skills', 'routines', 'telegram']);
    expect(r.json.checks.find((c: { id: string }) => c.id === 'claude-chrome')).toMatchObject({ required: false, state: 'optional' });
    expect(r.json.checks.find((c: { id: string }) => c.id === 'node').state).toBe('ok');
    expect(r.json.checks.find((c: { id: string }) => c.id === 'vault').state).toBe('todo');
    expect(r.json.progress.total).toBe(6);
    expect(r.json.runner).toBe('mock');
  });

  it('validates and saves a vault choice to data/local-env.json', async () => {
    ctx = makeCtx();
    expect(validateVault('/definitely/not/here').ok).toBe(false);
    expect(validateVault(FIXTURE_VAULT)).toMatchObject({ ok: true, obsidian: true });
    const bad = await ctx.req('POST', '/api/setup/vault', { path: '/nope' });
    expect(bad.status).toBe(400);
    const ok = await ctx.req('POST', '/api/setup/vault', { path: FIXTURE_VAULT, save: true });
    expect(ok.json).toMatchObject({ ok: true, saved: true, restartRequired: true });
    expect(JSON.parse(readFileSync(join(ctx.s.env.dataDir, 'local-env.json'), 'utf8')).JARVIS_VAULT).toBe(FIXTURE_VAULT);
    expect((await ctx.req('GET', '/api/setup')).json.pendingRestart).toBe(true);
  });

  it('keeps demo setup on sample data even when given local paths', async () => {
    ctx = makeCtx({ env: { JARVIS_DEMO: '1' } });
    expect((await ctx.req('GET', '/api/setup')).json.suggestions).toEqual({ vaults: [], codeRoots: [] });
    expect((await ctx.req('POST', '/api/setup/vault', { path: FIXTURE_VAULT, save: true })).status).toBe(409);
    expect((await ctx.req('POST', '/api/setup/projects', { repos: [{ path: FIXTURE_VAULT }] })).status).toBe(409);
    expect((await ctx.req('POST', '/api/projects', { name: 'External repo', path: FIXTURE_VAULT })).status).toBe(409);
    expect((await ctx.req('POST', '/api/projects/demo/worktrees/t_demo/pr')).status).toBe(400);
  });

  it('finds git repos under a folder and connects them as projects', async () => {
    ctx = makeCtx();
    const root = mkdtempSync(join(tmpdir(), 'jarvis-code-'));
    for (const name of ['alpha', 'nested/beta']) {
      mkdirSync(join(root, name), { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: join(root, name) });
    }
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'notes.txt'), 'x');
    expect(scanRepos(root, new Set()).map((r) => r.name)).toEqual(['alpha', 'beta']);
    const scan = await ctx.req('POST', '/api/setup/scan', { path: root });
    expect(scan.json.repos).toHaveLength(2);
    const add = await ctx.req('POST', '/api/setup/projects', { repos: scan.json.repos });
    expect(add.json.added).toBe(2);
    expect((await ctx.req('POST', '/api/setup/projects', { repos: scan.json.repos })).json.added).toBe(0);
    const again = await ctx.req('POST', '/api/setup/scan', { path: root });
    expect(again.json.repos.every((r: { registered: boolean }) => r.registered)).toBe(true);
    expect((await ctx.req('GET', '/api/setup')).json.checks.find((c: { id: string }) => c.id === 'projects').state).toBe('ok');
  });

  it('never calls real agents in mock mode and only restarts under the launcher', async () => {
    ctx = makeCtx();
    const v = await ctx.req('POST', '/api/setup/verify/claude');
    expect(v.status).toBe(409);
    expect(v.json.message).toMatch(/mock mode/);
    expect((await ctx.req('POST', '/api/setup/restart')).status).toBe(409);
  });

  it('validates Telegram details before saving', async () => {
    ctx = makeCtx();
    expect((await ctx.req('POST', '/api/setup/telegram', { token: 'abc', chatId: '1' })).status).toBe(400);
    const ok = await ctx.req('POST', '/api/setup/telegram', { token: '123456:ABCdefGhIJKlmNoPQRsTUVwxyZ0123456789', chatId: '42' });
    expect(ok.json.saved).toBe(true);
    const local = JSON.parse(readFileSync(join(ctx.s.env.dataDir, 'local-env.json'), 'utf8'));
    expect(local.TELEGRAM_ALLOWED_CHAT_ID).toBe('42');
  });
});
