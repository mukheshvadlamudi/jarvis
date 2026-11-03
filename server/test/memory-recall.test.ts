import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mcpOf } from '../src/mcp/module.ts';
import { factsIn, today } from '../src/memory/facts.ts';
import { consolidateBatch } from '../src/memory/maintenance.ts';
import { memoryOf } from '../src/memory/module.ts';
import { getSetting } from '../src/db/index.ts';
import { makeCtx } from './helpers.ts';
import type { TestCtx } from './helpers.ts';
let ctx: TestCtx;
afterEach(async () => ctx?.close());
function setup() { ctx = makeCtx(); return memoryOf(ctx.s); }
function note(path: string, content: string) {
  writeFileSync(join(ctx.s.env.vault, path), content);
  memoryOf(ctx.s).vault.indexFile(path);
}

describe('relaxed recall', () => {
  it('finds natural questions, punctuation, simple plurals, and labels partial coverage', () => {
    const { vault } = setup();
    note('Research/Backups.md', '# Storage\nBackups go to B2.');
    const hit = vault.search('where do my backups go?!')[0];
    expect(hit).toMatchObject({ path: 'Research/Backups.md', match: 'all words', matchedTerms: ['backup', 'go'] });
    expect(vault.search('backup destination')[0]).toMatchObject({ path: 'Research/Backups.md', match: 'some words', matchedTerms: ['backup'] });
    expect(vault.search('unicorn quantum backup')).toEqual([]);
    expect(vault.search('the and my')).toEqual([]);
    expect(vault.search('backup', { type: 'person' })).toEqual([]);
    expect(vault.search('"backup" OR *').map((h) => h.path)).toContain('Research/Backups.md');
  });
  it('boosts title and path then breaks ties by recency, including the LIKE fallback', () => {
    const { vault } = setup();
    note('Research/old.md', '# Storage\nquartz');
    note('Research/new.md', '# Storage\nquartz');
    ctx.s.db.prepare('UPDATE notes_index SET mtime = 1 WHERE path = ?').run('Research/old.md');
    ctx.s.db.prepare('UPDATE notes_index SET mtime = 2 WHERE path = ?').run('Research/new.md');
    expect(vault.search('quartz')[0].path).toBe('Research/new.md');
    note('Research/Quartz.md', '# Quartz\nStorage');
    expect(vault.search('quartz')[0].path).toBe('Research/Quartz.md');
    Object.defineProperty(vault, 'fts', { value: false });
    expect(vault.search('quartz destination')[0]).toMatchObject({ path: 'Research/Quartz.md', match: 'some words' });
  });
});

describe('Markdown facts', () => {
  it('adds, corrects instead of duplicating, preserves source and dates, and retracts', () => {
    const { proposals, vault } = setup();
    const input = { subject: 'Owner', predicate: 'backup destination', value: 'B2', source: 'owner message 1', validFrom: '2026-01-01', target: 'Research/preferences.md', op: 'add' as const };
    expect(proposals.proposeFact(input).status).toBe('applied');
    const first = factsIn(vault.read(input.target)!.content)[0];
    expect(first).toMatchObject({ validFrom: '2026-01-01', validTo: null, supersedes: null, source: input.source });
    expect(proposals.proposeFact(input).status).toBe('noop');
    proposals.proposeFact({ ...input, value: 'Wasabi', op: 'update', source: 'owner message 2' });
    const facts = factsIn(vault.read(input.target)!.content);
    expect(facts.find((f) => f.id === first.id)?.validTo).toBe(today());
    expect(facts.find((f) => f.value === 'Wasabi')).toMatchObject({ supersedes: first.id, validTo: null });
    expect(vault.search('B2').map((h) => h.path)).not.toContain(input.target);
    expect(vault.search('backup').find((h) => h.path === input.target)!.facts).toHaveLength(1);
    expect(vault.search('backup history').find((h) => h.path === input.target)!.facts).toHaveLength(2);
    proposals.proposeFact({ ...input, value: '', op: 'retract' });
    expect(vault.search('backup').find((h) => h.path === input.target)?.facts ?? []).toEqual([]);
    expect(vault.search('B2', { history: true }).map((h) => h.path)).toContain(input.target);
    expect(proposals.proposeFact({ ...input, op: 'retract' }).status).toBe('noop');
    expect(proposals.proposeFact({ ...input, op: 'noop' }).status).toBe('noop');
    expect(() => proposals.proposeFact({ ...input, validFrom: '2026-02-30' })).toThrow();
  });
  it('gates canonical protected paths and persists rejected fingerprints independent of source', () => {
    const { proposals, vault } = setup();
    for (const target of ['./CORE.md', 'Projects/../People/Ada.md', 'Areas/Preferences.md']) {
      const input = { subject: target, predicate: 'prefers', value: 'quiet | "rooms"\nwith daylight', source: 'run:one', target, op: 'add' as const };
      const p = proposals.proposeFact(input);
      expect(p.status).toBe('pending');
      expect(proposals.proposeFact(input).id).toBe(p.id);
      proposals.decide(p.id!, 'rejected');
      expect(proposals.proposeFact({ ...input, source: 'run:two' })).toMatchObject({ id: p.id, status: 'rejected' });
      expect(proposals.proposeFact({ ...input, target: 'Research/another-note.md', op: 'update' })).toMatchObject({ id: p.id, status: 'rejected' });
    }
    const p = proposals.proposeFact({ subject: 'Owner', predicate: 'likes', value: 'tea', source: 'owner', target: 'CORE.md', op: 'add' });
    proposals.decide(p.id!, 'approved');
    expect(factsIn(vault.read('CORE.md')!.content)[0].value).toBe('tea');
    const correction = proposals.proposeFact({ subject: 'owner', predicate: 'likes', value: 'coffee', source: 'owner', target: 'Research/bypass.md', op: 'update' });
    expect(correction).toMatchObject({ status: 'pending', target_path: 'CORE.md' });
    expect(() => proposals.proposeFact({ subject: 'x', predicate: 'y', value: 'z', source: 'owner', target: '../../escape', op: 'add' })).toThrow();
  });
  it('does not retrieve future facts as current', () => {
    const { proposals, vault } = setup();
    proposals.proposeFact({ subject: 'Owner', predicate: 'destination', value: 'Neptune', source: 'plan', validFrom: '2099-01-01', target: 'Research/future.md', op: 'add' });
    expect(vault.search('Neptune')).toEqual([]);
    expect(vault.search('Neptune history')).toHaveLength(1);
  });
});

describe('bounded consolidation', () => {
  it('resumes a durable checkpoint, proposes without rewriting, and notices changed notes', async () => {
    const { vault, proposals } = setup();
    ctx.s.db.prepare('DELETE FROM notes_index').run();
    note('Research/batch-a.md', '# A\nold'); note('Research/batch-b.md', '# B\nold');
    ctx.s.db.prepare('UPDATE notes_index SET mtime = 10').run();
    const input = { db: ctx.s.db, vault, proposals, noteBudget: 1, review: async (n: { content: string }) => [{ content: n.content + '\nReviewed', reason: 'Consolidated' }] };
    const a = await consolidateBatch(input);
    expect(a).toMatchObject({ reviewed: 1, remaining: true });
    expect(proposals.get(a.proposals[0])?.status).toBe('pending');
    expect(vault.read('Research/batch-a.md')!.content).not.toContain('Reviewed');
    expect(await consolidateBatch(input)).toMatchObject({ reviewed: 1, remaining: false });
    expect(await consolidateBatch(input)).toMatchObject({ reviewed: 0 });
    note('Research/batch-a.md', '# A\nChanged');
    expect(await consolidateBatch(input)).toMatchObject({ reviewed: 1 });
    expect(getSetting(ctx.s.db, 'memory.consolidation.receipt', null)).toBeTruthy();
  });
  it('retries failed reviews without advancing the checkpoint', async () => {
    const { vault, proposals } = setup();
    const input = { db: ctx.s.db, vault, proposals, noteBudget: 1, review: async () => { throw new Error('interrupted'); } };
    await expect(consolidateBatch(input)).rejects.toThrow('interrupted');
    expect(getSetting(ctx.s.db, 'memory.consolidation.checkpoint', null)).toBeNull();
    expect(await consolidateBatch({ ...input, review: async () => [] })).toMatchObject({ reviewed: 1 });
  });
});


describe('memory MCP contract', () => {
  it('accepts optional facts, reports matches and dates, and keeps legacy saves working', async () => {
    const { vault, proposals } = setup();
    const hub = mcpOf(ctx.s);
    const run = { runId: 'fixture-run', taskId: 'fixture-task' };
    expect((await hub.call(run, 'save_memory', { fact: 'bad' })).isError).toBe(true);
    expect((await hub.call(run, 'save_memory', { fact: { subject: 'owner' } })).isError).toBe(true);
    const args = { target: 'Research/mcp-facts.md', fact: { subject: 'Owner', predicate: 'archive', value: 'Glacier', op: 'add' } };
    expect((await hub.call(run, 'save_memory', args)).text).toContain('Saved');
    const search = await hub.call(run, 'search_memory', { query: 'Glacier destination' });
    expect(search.text).toContain('some words: glacier');
    expect(search.text).toContain('source: run:fixture-run');
    expect(search.text).toContain('valid unknown to open');
    expect((await hub.call(run, 'read_note', { path: args.target })).text).toContain('## Facts');
    expect((await hub.call(run, 'save_memory', { target: 'Inbox.md', content: '- Keep receipts' })).text).toContain('Saved');
    expect(vault.read('Inbox.md')!.content).toContain('Keep receipts');
    await hub.call(run, 'save_memory', { ...args, target: './CORE.md', fact: { subject: 'Owner', predicate: 'drink', value: 'Tea', op: 'add' } });
    const pending = proposals.list('pending')[0]; proposals.decide(pending.id, 'rejected');
    expect((await hub.call(run, 'save_memory', { target: './CORE.md', fact: { subject: 'Owner', predicate: 'drink', value: 'Tea', op: 'add' } })).text).toContain('rejected');
  });
  it('searches only conversation-visible runs, using owner_text instead of executable prompts', async () => {
    setup();
    const task = ctx.s.tasks.create({ title: 'Archive discussion', run: false });
    ctx.s.db.prepare("UPDATE tasks SET mode = 'chat' WHERE id = ?").run(task.id);
    const insert = ctx.s.db.prepare("INSERT INTO runs (id, task_id, agent, cwd, started_at, status, prompt, owner_text, answer, purpose, visibility, route_reason) VALUES (?, ?, 'codex', '.', '2026-11-03', 'done', 'secret instructions', ?, ?, ?, ?, ?)");
    insert.run('public-run', task.id, 'Discuss archives', 'Visible archive answer', 'user_reply', 'conversation', null);
    insert.run('internal-run', task.id, null, 'archive internal secret', 'learning', 'internal', null);
    insert.run('consult-run', task.id, null, 'archive consult secret', null, null, 'consult:peer');
    const result = await mcpOf(ctx.s).call({ runId: 'other', taskId: 'other' }, 'search_conversations', { query: 'archive' });
    expect(result.text).toContain('Discuss archives');
    expect(result.text).not.toMatch(/secret|instructions/);
  });
});
