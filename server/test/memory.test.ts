import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { unifiedDiff } from '../src/memory/diff.ts';
import { parseFrontmatter } from '../src/memory/frontmatter.ts';
import { migrationProposal, sizeAlerts } from '../src/memory/maintenance.ts';
import { memoryOf } from '../src/memory/module.ts';
import { FIXTURE_VAULT, makeCtx, waitFor } from './helpers.ts';
import type { TestCtx } from './helpers.ts';

let ctx: TestCtx;
afterEach(async () => ctx?.close());

describe('frontmatter + diff', () => {
  it('parses Obsidian frontmatter', () => {
    const r = parseFrontmatter('---\ntype: project\ntags: [a, b]\nlist:\n  - x\n  - y\nn: 3\n---\n# Title\nBody');
    expect(r.data).toEqual({ type: 'project', tags: ['a', 'b'], list: ['x', 'y'], n: 3 });
    expect(r.body).toBe('# Title\nBody');
    expect(parseFrontmatter('# No front').hasFrontmatter).toBe(false);
  });
  it('produces unified diffs', () => {
    const d = unifiedDiff('a\nb\nc\n', 'a\nB\nc\nd\n', 'x.md');
    expect(d).toContain('--- a/x.md');
    expect(d).toContain('-b');
    expect(d).toContain('+B');
    expect(d).toContain('+d');
    expect(unifiedDiff('same\n', 'same\n', 'x.md')).toBe('');
  });
});

describe('vault index', () => {
  it('indexes the fixture vault copy, ignores .obsidian and binaries, and never writes fixtures', () => {
    ctx = makeCtx();
    const { vault } = memoryOf(ctx.s);
    expect(ctx.s.env.vault).not.toBe(FIXTURE_VAULT);
    expect(vault.fts).toBe(true);
    const paths = vault.list().map((n) => n.path);
    expect(paths).toContain('CORE.md');
    expect(paths).toContain('Projects/ClientEasy.md');
    expect(paths.some((p) => p.startsWith('.obsidian'))).toBe(false);
    expect(paths.some((p) => p.endsWith('.png'))).toBe(false);
    const p = vault.list().find((n) => n.path === 'People/Priya Patel.md')!;
    expect(p).toMatchObject({ type: 'person', title: 'Priya Patel', tags: 'client,billing' });
    expect(vault.indexAll()).toBe(0); // unchanged on second scan
  });

  it('searches with FTS ranking and snippets', async () => {
    ctx = makeCtx();
    const res = await ctx.req('GET', '/api/memory/search?q=deposit%20sign-off');
    expect(res.json.results[0].path).toMatch(/Northwind Dental|Priya Patel/);
    expect(res.json.results[0].snippet).toContain('\u0001');
    const typed = await ctx.req('GET', '/api/memory/search?q=Umami&type=research');
    expect(typed.json.results.map((r: { path: string }) => r.path)).toEqual(['Research/2026-11-01-privacy-analytics.md']);
    expect((await ctx.req('GET', '/api/memory/note?path=../../etc/passwd')).status).toBe(400);
  });

  it('picks up edits through the watcher', async () => {
    ctx = makeCtx();
    const { vault } = memoryOf(ctx.s);
    vault.watch(50);
    writeFileSync(join(ctx.s.env.vault, 'Areas/Garden.md'), '# Garden\n\nPlant garlic before the first frost.');
    await waitFor(() => vault.search('garlic').length > 0, 4000);
    expect(vault.search('garlic')[0].path).toBe('Areas/Garden.md');
  });
});

describe('context builder', () => {
  it('loads CORE + project note + skill descriptions within budget and reports tokens', async () => {
    ctx = makeCtx();
    const project = ctx.s.db.prepare("INSERT INTO projects (id, name, kind, vault_note, created_at) VALUES ('p1', 'ClientEasy', 'code', 'Projects/ClientEasy.md', ?) RETURNING *").get(new Date().toISOString()) as never;
    const task = ctx.s.tasks.create({ title: 'Fix the flaky date-picker test in ClientEasy', run: false });
    const built = await ctx.s.orchestrator.context.build(task, project);
    const labels = built.report.items.map((i) => i.label);
    expect(labels).toEqual(['Jarvis instructions', 'CORE.md', 'Project: ClientEasy', 'Skill descriptions (6)']);
    expect(built.prefix).toContain('Ship ClientEasy 2.5');
    expect(built.prefix).toContain('- release-notes: Write release notes');
    expect(built.prefix).not.toContain('Number the steps'); // skill bodies are not loaded
    expect(built.report.totalTokens).toBeLessThanOrEqual(built.report.budgetTokens);
    expect(built.report.truncated).toBe(false);
  });

  it('trims lowest-priority parts first when over budget', async () => {
    ctx = makeCtx();
    ctx.s.config.update({ memory: { contextBudgetTokens: 1000 } });
    const project = { id: 'p', name: 'Atlas CRM', kind: 'client', path: null, repo: null, vault_note: 'Projects/Atlas CRM.md', created_at: '' } as const;
    const built = await ctx.s.orchestrator.context.build(ctx.s.tasks.create({ title: 'x', run: false }), project);
    expect(built.report.truncated).toBe(true);
    expect(built.report.totalTokens).toBeLessThanOrEqual(1000);
    expect(built.report.items[0]).toMatchObject({ label: 'Jarvis instructions' });
    expect(built.report.items.find((i) => i.kind === 'skills')).toBeUndefined();
  });
});

describe('memory proposals', () => {
  it('auto-applies low-risk appends and gates CORE/Projects/People edits with backups', async () => {
    ctx = makeCtx();
    const { proposals } = memoryOf(ctx.s);
    const inbox = proposals.propose({ target: 'Inbox.md', content: '- Renew domain in February', reason: 'note' });
    expect(inbox.status).toBe('applied');
    expect(readFileSync(join(ctx.s.env.vault, 'Inbox.md'), 'utf8')).toContain('Renew domain in February');

    const core = proposals.propose({ target: 'CORE.md', content: '- Prefers invoices as PDF', reason: 'Owner said so' });
    expect(core.status).toBe('pending');
    expect(core.diff).toContain('+- Prefers invoices as PDF');
    expect(readFileSync(join(ctx.s.env.vault, 'CORE.md'), 'utf8')).not.toContain('Prefers invoices as PDF');

    const list = await ctx.req('GET', '/api/memory/proposals?status=pending');
    expect(list.json.pending).toBe(1);
    const res = await ctx.req('POST', `/api/memory/proposals/${core.id}`, { decision: 'approved' });
    expect(res.json.proposal.status).toBe('applied');
    expect(readFileSync(join(ctx.s.env.vault, 'CORE.md'), 'utf8')).toContain('Prefers invoices as PDF');
    const backups = join(ctx.s.env.dataDir, 'backups');
    const day = readdirSync(backups)[0];
    expect(readFileSync(join(backups, day, 'CORE.md'), 'utf8')).not.toContain('Prefers invoices as PDF');
    expect(memoryOf(ctx.s).vault.search('Prefers invoices PDF').map((h) => h.path)).toContain('CORE.md');
  });

  it('rejects stale replace proposals and supports batch decisions', async () => {
    ctx = makeCtx();
    const { proposals } = memoryOf(ctx.s);
    const a = proposals.propose({ target: 'People/Sam Okafor.md', content: '# Sam Okafor\n\n- Rewritten', reason: 'tidy', mode: 'replace' });
    writeFileSync(join(ctx.s.env.vault, 'People/Sam Okafor.md'), '# Sam\nchanged by owner\n');
    expect(proposals.decide(a.id, 'approved').status).toBe('failed');
    const b = proposals.propose({ target: 'Projects/Jarvis.md', content: '- Phase 2a in progress', reason: 'status' });
    const c = proposals.propose({ target: 'Projects/Jarvis.md', content: '- Remove me', reason: 'noise' });
    const r = await ctx.req('POST', '/api/memory/proposals/batch', { ids: [b.id, c.id], decision: 'rejected' });
    expect(r.json.results.map((x: { status: string }) => x.status)).toEqual(['rejected', 'rejected']);
    expect(() => proposals.propose({ target: 'Skills/x/SKILL.md', content: 'x', reason: 'y' })).toThrow(/skill proposals/);
  });

  it('appends one line per finished task to the daily note', async () => {
    ctx = makeCtx({ mockDelayMs: 1 });
    const id = (await ctx.req('POST', '/api/tasks', { title: 'Summarise unread email' })).json.task.id;
    await waitFor(() => ctx.s.tasks.get(id)?.status === 'done');
    const d = new Date();
    const file = join(ctx.s.env.vault, 'Journal/DAILY', `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.md`);
    await waitFor(() => existsSync(file) && readFileSync(file, 'utf8').includes('Summarise unread email'));
    expect(readFileSync(file, 'utf8')).toMatch(/- \d\d:\d\d Summarise unread email — .+ \((Claude|Codex)\)/);
  });
});

describe('maintenance', () => {
  it('flags oversized notes and proposes a migration without moving files', () => {
    ctx = makeCtx();
    const { vault } = memoryOf(ctx.s);
    const alerts = sizeAlerts(vault, ctx.s.config.get());
    expect(alerts.map((a) => a.path)).toEqual(['Projects/Atlas CRM.md']);
    const items = migrationProposal(vault, ctx.s.config.get());
    expect(items).toContainEqual(expect.objectContaining({ action: 'merge', from: 'clienteasy roadmap.md', to: 'Projects/ClientEasy.md' }));
    expect(items).toContainEqual(expect.objectContaining({ action: 'move', from: 'meeting notes sam.md', to: 'Journal/meeting notes sam.md' }));
    expect(items).toContainEqual(expect.objectContaining({ action: 'trim', from: 'Projects/Atlas CRM.md' }));
    expect(existsSync(join(ctx.s.env.vault, 'clienteasy roadmap.md'))).toBe(true);
  });
});
