import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { kindOf } from '../src/workspaces/outputs.ts';
import { makeCtx, waitFor } from './helpers.ts';
import type { TestCtx } from './helpers.ts';

let ctx: TestCtx;
afterEach(async () => ctx?.close());

describe('task outputs', () => {
  it('detects kinds', () => {
    expect(['a.md', 'b.csv', 'c.png', 'd.pdf', 'e.docx', 'f.ts', 'g.html', 'h.bin'].map(kindOf)).toEqual(['markdown', 'csv', 'image', 'pdf', 'office', 'code', 'html', 'binary']);
  });

  it('lists files a run produced and serves them with safe headers', async () => {
    ctx = makeCtx({ mockDelayMs: 1 });
    const id = (await ctx.req('POST', '/api/tasks', { title: 'Draft the Harbor & Pine monthly report', type: 'write' })).json.task.id;
    await waitFor(() => ctx.s.tasks.get(id)?.status === 'done');
    const list = await ctx.req('GET', `/api/tasks/${id}/outputs`);
    const names = list.json.files.map((f: { path: string }) => f.path).sort();
    expect(names).toEqual(['draft.md', 'traffic.csv']);
    expect(list.json.files.find((f: { path: string }) => f.path === 'draft.md')).toMatchObject({ kind: 'markdown', changed: true, folder: 0 });
    const raw = await ctx.app.request(`/api/tasks/${id}/outputs/raw?folder=0&path=draft.md`);
    expect(raw.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(raw.headers.get('content-security-policy')).toMatch(/^sandbox/);
    expect(await raw.text()).toContain('Oak Sideboard');
    const dl = await ctx.app.request(`/api/tasks/${id}/outputs/raw?folder=0&path=traffic.csv&download=1`);
    expect(dl.headers.get('content-disposition')).toBe('attachment; filename="traffic.csv"');
  });

  it('refuses paths outside the task folder, including symlinks', async () => {
    ctx = makeCtx({ mockDelayMs: 1 });
    const id = (await ctx.req('POST', '/api/tasks', { title: 'Draft a launch note', type: 'write' })).json.task.id;
    await waitFor(() => ctx.s.tasks.get(id)?.status === 'done');
    expect((await ctx.app.request(`/api/tasks/${id}/outputs/raw?folder=0&path=../../etc/passwd`)).status).toBe(400);
    const cwd = ctx.s.orchestrator.runsForTask(id)[0].cwd;
    const outside = mkdtempSync(join(tmpdir(), 'jarvis-secret-'));
    writeFileSync(join(outside, 'secret.txt'), 'nope');
    symlinkSync(outside, join(cwd, 'linked'), 'junction');
    expect((await ctx.app.request(`/api/tasks/${id}/outputs/raw?folder=0&path=linked/secret.txt`)).status).toBe(400);
    expect((await ctx.app.request(`/api/tasks/${id}/outputs/raw?folder=3&path=draft.md`)).status).toBe(404);
  });

  it('saves outputs into the vault', async () => {
    ctx = makeCtx({ mockDelayMs: 1 });
    const id = (await ctx.req('POST', '/api/tasks', { title: 'Draft the Harbor & Pine monthly report', type: 'write' })).json.task.id;
    await waitFor(() => ctx.s.tasks.get(id)?.status === 'done');
    const md = await ctx.req('POST', `/api/tasks/${id}/outputs/save`, { folder: 0, path: 'draft.md', target: 'Projects/Reports' });
    expect(md.json.saved).toMatch(/^Projects\/Reports\/\d{4}-\d{2}-\d{2}-draft\.md$/);
    expect(readFileSync(join(ctx.s.env.vault, md.json.saved), 'utf8')).toContain('Oak Sideboard');
    const csv = await ctx.req('POST', `/api/tasks/${id}/outputs/save`, { folder: 0, path: 'traffic.csv' });
    expect(csv.json.saved).toMatch(/^Jarvis\/Outputs\/.+-traffic\.csv\.md$/);
    expect((await ctx.req('POST', `/api/tasks/${id}/outputs/save`, { folder: 0, path: 'draft.md', target: 'Skills/x' })).status).toBe(400);
  });

  it('shows only changed files for git worktrees', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'jarvis-repo-'));
    const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e', '-c', 'init.defaultBranch=main', ...a], { cwd });
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'a.ts'), 'a\n');
    writeFileSync(join(repo, 'b.ts'), 'b\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    ctx = makeCtx({ mockDelayMs: 1 });
    await ctx.req('POST', '/api/projects', { name: 'Repo', kind: 'code', path: repo });
    const id = (await ctx.req('POST', '/api/tasks', { title: 'Fix the bug in Repo' })).json.task.id;
    await waitFor(() => ctx.s.tasks.get(id)?.status === 'done');
    const wt = ctx.s.orchestrator.runsForTask(id)[0].cwd;
    writeFileSync(join(wt, 'a.ts'), 'a2\n');
    git(wt, 'commit', '-qam', 'change a');
    writeFileSync(join(wt, 'notes.md'), '# notes');
    const files = (await ctx.req('GET', `/api/tasks/${id}/outputs`)).json.files.map((f: { path: string }) => f.path).sort();
    expect(files).toEqual(['a.ts', 'notes.md']);
    expect(existsSync(join(wt, 'b.ts'))).toBe(true);
  });
});
