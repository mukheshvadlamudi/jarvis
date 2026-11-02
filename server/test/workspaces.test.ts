import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { schedulerOf } from '../src/scheduler/module.ts';
import { parseFeed, plainText } from '../src/workspaces/feeds.ts';
import { workspacesOf } from '../src/workspaces/module.ts';
import { openThreads } from '../src/workspaces/people.ts';
import { parseShortstat, parseWorktrees } from '../src/workspaces/projects.ts';
import { REPO, makeCtx, waitFor } from './helpers.ts';
import type { TestCtx } from './helpers.ts';

let ctx: TestCtx;
afterEach(async () => ctx?.close());

const FEEDS = join(REPO, 'fixtures/feeds');
let server: Server;
let base = '';
let page = readFileSync(join(FEEDS, 'status-page.html'), 'utf8');
beforeAll(async () => {
  server = createServer((req, res) => {
    const files: Record<string, string> = { '/node.xml': 'node-blog.rss.xml', '/hono.atom': 'hono-releases.atom.xml' };
    if (req.url === '/status') return res.end(page);
    if (req.url === '/broken') {
      res.statusCode = 500;
      return res.end('nope');
    }
    const f = files[req.url ?? ''];
    if (!f) {
      res.statusCode = 404;
      return res.end();
    }
    res.end(readFileSync(join(FEEDS, f)));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

describe('research', () => {
  it('saves the report to vault/Research with Sources, and follow-ups update the same note', async () => {
    ctx = makeCtx({ mockDelayMs: 1 });
    const id = (await ctx.req('POST', '/api/tasks', { title: 'Research the best Postgres backup tools for a small VPS' })).json.task.id;
    await waitFor(() => ctx.s.tasks.get(id)?.output_path);
    const t = ctx.s.tasks.get(id)!;
    expect(t.output_path).toMatch(/^Research\/\d{4}-\d{2}-\d{2}-research-the-best-postgres-backup-tools(-[a-z]+)*\.md$/);
    const note = readFileSync(join(ctx.s.env.vault, t.output_path!), 'utf8');
    expect(note).toContain('type: research');
    expect(note).toContain(`task: ${id}`);
    expect(note).toContain('## Sources');
    expect(note).toContain('pgBackRest');
    const list = await ctx.req('GET', '/api/research');
    expect(list.json.reports[0]).toMatchObject({ path: t.output_path, task: { id, status: 'done' } });
    const searched = await ctx.req('GET', '/api/research?q=pgBackRest');
    expect(searched.json.reports.map((r: { path: string }) => r.path)).toContain(t.output_path);

    await ctx.req('POST', `/api/tasks/${id}/followup`, { text: 'What about restore times on 2 GB RAM?' });
    await waitFor(() => ctx.s.orchestrator.runsForTask(id).length === 2 && ctx.s.tasks.get(id)?.status === 'done');
    await waitFor(() => (ctx.s.db.prepare("SELECT COUNT(*) AS n FROM memory_proposals WHERE target_path = ? AND status = 'applied'").get(t.output_path!) as { n: number }).n === 2);
    expect(ctx.s.tasks.get(id)?.output_path).toBe(t.output_path);
  });
});

describe('feeds', () => {
  it('parses RSS and GitHub Atom', () => {
    const rss = parseFeed(readFileSync(join(FEEDS, 'node-blog.rss.xml'), 'utf8'));
    expect(rss.title).toBe('Node.js Blog');
    expect(rss.items[0]).toMatchObject({ title: 'Node.js 24.11.1 (LTS) — security release', url: 'https://nodejs.org/en/blog/release/v24.11.1', published_at: '2026-10-28T14:00:00.000Z' });
    expect(rss.items[0].summary).toBe('Fixes two medium-severity issues in http and the permission model. Upgrade recommended.');
    const atom = parseFeed(readFileSync(join(FEEDS, 'hono-releases.atom.xml'), 'utf8'));
    expect(atom.items[0]).toMatchObject({ title: 'v4.13.17', url: 'https://github.com/honojs/hono/releases/tag/v4.13.17' });
    expect(atom.items[0].summary).toBe("What's Changed fix(streaming): close SSE streams on client abort");
    expect(plainText('<p>a &amp; b</p>')).toBe('a & b');
  });

  it('adds sources, dedupes items, diffs plain pages, records errors and marks seen after a digest', async () => {
    ctx = makeCtx({ mockDelayMs: 1 });
    const node = await ctx.req('POST', '/api/feeds', { url: `${base}/node.xml` });
    expect(node.json.source).toMatchObject({ name: 'Node.js Blog', kind: 'rss' });
    await ctx.req('POST', '/api/feeds', { url: `${base}/hono.atom` });
    const status = await ctx.req('POST', '/api/feeds', { url: `${base}/status` });
    expect(status.json.source).toMatchObject({ kind: 'page', name: 'Hetzner Status' });
    expect((await ctx.req('POST', '/api/feeds', { url: `${base}/node.xml` })).status).toBe(400);
    expect((await ctx.req('GET', '/api/feeds/items?unseen=1')).json.items).toHaveLength(4);
    expect((await ctx.req('POST', '/api/feeds/fetch')).json.added).toBe(0);
    page = page.replace('All systems operational.', 'Degraded performance in fsn1.');
    expect((await ctx.req('POST', '/api/feeds/fetch')).json.added).toBe(1);
    const items = (await ctx.req('GET', '/api/feeds/items')).json.items;
    expect(items.find((i: { title: string }) => i.title === 'Hetzner Status changed').summary).toContain('Degraded performance');
    const broken = await ctx.req('POST', '/api/feeds', { url: `${base}/broken`, name: 'Broken' });
    expect(workspacesOf(ctx.s).feeds.source(broken.json.source.id)?.last_error).toBe('HTTP 500');

    const digest = schedulerOf(ctx.s).list().find((x) => x.built_in === 'updates_digest')!;
    const task = (await ctx.req('POST', `/api/schedules/${digest.id}/run-now`)).json.task;
    expect(task.body).toContain('Node.js 24.11.1 (LTS) — security release');
    await waitFor(() => ctx.s.tasks.get(task.id)?.status === 'done');
    await waitFor(() => (ctx.s.db.prepare('SELECT COUNT(*) AS n FROM feed_items WHERE seen = 0').get() as { n: number }).n === 0);
  });
});

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });
}

describe('code projects', () => {
  it('parses git output', () => {
    expect(parseShortstat(' 2 files changed, 49 insertions(+), 4 deletions(-)')).toEqual({ files: 2, insertions: 49, deletions: 4 });
    expect(parseShortstat(' 1 file changed, 3 insertions(+)')).toEqual({ files: 1, insertions: 3, deletions: 0 });
    expect(parseWorktrees('worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /r/.jarvis-worktrees/t_1\nHEAD def\nbranch refs/heads/jarvis/t_1-x\n')).toEqual([
      { path: '/r', branch: 'main' },
      { path: '/r/.jarvis-worktrees/t_1', branch: 'jarvis/t_1-x' },
    ]);
  });

  it('runs code tasks in worktrees, shows diff stats, gates PRs behind approval and cleans up', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'jarvis-repo-'));
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'CLAUDE.md'), '# Rules\n\nRun tests before pushing.\n');
    writeFileSync(join(repo, 'app.ts'), 'export const a = 1;\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    ctx = makeCtx({ mockDelayMs: 1 });
    const p = (await ctx.req('POST', '/api/projects', { name: 'Demo App', kind: 'code', path: repo })).json.project;
    const id = (await ctx.req('POST', '/api/tasks', { title: 'Fix the flaky test in Demo App' })).json.task.id;
    await waitFor(() => ctx.s.tasks.get(id)?.status === 'done');
    const wt = join(repo, '.jarvis-worktrees', id);
    expect(ctx.s.orchestrator.runsForTask(id)[0].cwd).toBe(wt);
    writeFileSync(join(wt, 'app.ts'), 'export const a = 2;\nexport const b = 3;\n');
    git(wt, 'commit', '-qam', 'fix');

    const ov = (await ctx.req('GET', '/api/projects/overview')).json.projects.find((x: { id: string }) => x.id === p.id);
    expect(ov).toMatchObject({ isGit: true, branch: 'main', claudeMd: { tokens: 9 }, agentsMd: null });
    expect(ov.worktrees[0]).toMatchObject({ taskId: id, diff: { files: 1, insertions: 2, deletions: 1 }, dirty: 0, task: { id, status: 'done' } });
    expect(ov.worktrees[0].branch).toMatch(new RegExp(`^jarvis/${id}-fix-the-flaky-test`));

    const calls: string[] = [];
    workspacesOf(ctx.s).projects.exec = async (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      if (args.includes('rev-parse')) return { stdout: `${ov.worktrees[0].branch}\n`, stderr: '' };
      return { stdout: cmd === 'gh' ? 'https://github.com/owner/demo/pull/7\n' : '', stderr: '' };
    };
    const pr = await ctx.req('POST', `/api/projects/${p.id}/worktrees/${id}/pr`);
    expect(pr.json.approval).toMatchObject({ kind: 'pull_request', status: 'pending' });
    expect(calls).toEqual(['git rev-parse --abbrev-ref HEAD']);
    calls.length = 0;
    await ctx.req('POST', `/api/approvals/${pr.json.approval.id}`, { decision: 'approved' });
    await waitFor(() => ctx.s.tasks.get(id)?.output_path === 'https://github.com/owner/demo/pull/7');
    expect(calls[0]).toMatch(/^git push -u origin jarvis\//);
    expect(calls[1]).toMatch(/^gh pr create --head jarvis\/.+ --fill$/);
    expect(ctx.s.orchestrator.runsForTask(id)).toHaveLength(1); // approving a PR does not resume the agent
  });

  it('removes worktrees, refusing dirty ones unless forced', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'jarvis-repo-'));
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    ctx = makeCtx({ mockDelayMs: 1 });
    const p = (await ctx.req('POST', '/api/projects', { name: 'Tiny', kind: 'code', path: repo })).json.project;
    const id = (await ctx.req('POST', '/api/tasks', { title: 'Refactor the Tiny code' })).json.task.id;
    await waitFor(() => ctx.s.tasks.get(id)?.status === 'done');
    const wt = join(repo, '.jarvis-worktrees', id);
    writeFileSync(join(wt, 'new.txt'), 'untracked');
    const r1 = await ctx.req('DELETE', `/api/projects/${p.id}/worktrees/${id}`);
    expect(r1.status).toBe(409);
    expect(r1.json.message).toMatch(/uncommitted changes/);
    expect((await ctx.req('DELETE', `/api/projects/${p.id}/worktrees/${id}?force=1`)).status).toBe(200);
    expect(existsSync(wt)).toBe(false);
    expect(git(repo, 'branch', '--list', 'jarvis/*')).toContain(id); // branch kept
  });
});

describe('people', () => {
  it('lists people with follow-ups and open threads, and updates frontmatter from the page', async () => {
    ctx = makeCtx();
    expect(openThreads('- Open threads:\n  - One\n  - Two\n- Other')).toEqual(['One', 'Two']);
    const r = await ctx.req('GET', '/api/people');
    expect(r.json.people.map((p: { name: string }) => p.name)).toEqual(['Priya Patel', 'Sam Okafor', 'Dana Whitfield']);
    expect(r.json.people[0]).toMatchObject({ company: 'Northwind Dental', follow_up: '2026-11-04', openThreads: ['November invoice question (overage) — reply drafted, waiting for approval.', 'Deposit amounts sign-off for the booking flow.'] });
    const t = await ctx.req('POST', '/api/people/touch', { path: 'People/Sam Okafor.md', contacted: true, followUp: '2026-11-20' });
    expect(t.json.person).toMatchObject({ follow_up: '2026-11-20' });
    expect(t.json.person.last_contact).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const text = readFileSync(join(ctx.s.env.vault, 'People/Sam Okafor.md'), 'utf8');
    expect(text).toContain('follow_up: 2026-11-20');
    expect(text).toContain('# Sam Okafor');
    expect((await ctx.req('POST', '/api/people/touch', { path: 'People/Sam Okafor.md', followUp: 'soon' })).status).toBe(400);
  });
});
