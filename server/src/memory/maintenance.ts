import { existsSync } from 'node:fs';
import type { JarvisConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { all, getSetting, setSetting } from '../db/index.ts';
import type { MemoryProposals } from './proposals.ts';
import type { Note, NoteRow } from './vault.ts';
import type { VaultIndex } from './vault.ts';

export interface SizeAlert {
  path: string;
  tokens: number;
  cap: number;
  kind: 'core' | 'project';
}

export function sizeAlerts(vault: VaultIndex, cfg: JarvisConfig): SizeAlert[] {
  const out: SizeAlert[] = [];
  for (const n of vault.list()) {
    if (n.path === 'CORE.md' && n.tokens > cfg.memory.coreCapTokens) out.push({ path: n.path, tokens: n.tokens, cap: cfg.memory.coreCapTokens, kind: 'core' });
    if (n.path.startsWith('Projects/') && n.tokens > cfg.memory.projectCapTokens) out.push({ path: n.path, tokens: n.tokens, cap: cfg.memory.projectCapTokens, kind: 'project' });
  }
  return out.sort((a, b) => b.tokens / b.cap - a.tokens / a.cap);
}

export interface MigrationItem {
  action: 'create' | 'move' | 'merge' | 'trim';
  from: string | null;
  to: string;
  reason: string;
}

const TARGET_FOLDERS = ['Areas', 'Projects', 'People', 'Skills', 'Research', 'Journal/DAILY'];

/**
 * One-time migration proposal toward the SPEC §9 layout. Read-only: lists suggested moves; the owner
 * moves files in Obsidian (which keeps links up to date). Never moves anything itself.
 */
export function migrationProposal(vault: VaultIndex, cfg: JarvisConfig): MigrationItem[] {
  const items: MigrationItem[] = [];
  if (!existsSync(vault.resolve('CORE.md'))) items.push({ action: 'create', from: null, to: 'CORE.md', reason: `Always loaded into every run; keep it under ${cfg.memory.coreCapTokens.toLocaleString()} tokens.` });
  if (!existsSync(vault.resolve('Inbox.md'))) items.push({ action: 'create', from: null, to: 'Inbox.md', reason: 'Quick capture list that agents can append to.' });
  for (const f of TARGET_FOLDERS) {
    if (!existsSync(vault.resolve(f))) items.push({ action: 'create', from: null, to: `${f}/`, reason: 'Part of the standard layout Jarvis reads.' });
  }
  const notes = vault.list();
  const projects = notes.filter((n) => n.path.startsWith('Projects/')).map((n) => ({ path: n.path, name: n.path.slice(9, -3).toLowerCase() }));
  for (const n of notes) {
    const name = n.path.split('/').pop()!;
    const base = name.replace(/\.md$/, '');
    const inFolder = n.path.includes('/');
    if (/^\d{4}-\d{2}-\d{2}$/.test(base) && !n.path.startsWith('Journal/DAILY/')) {
      items.push({ action: 'move', from: n.path, to: `Journal/DAILY/${name}`, reason: 'Daily notes live in Journal/DAILY and are never preloaded.' });
      continue;
    }
    if (n.path.startsWith('Skills/') && !/^Skills\/[^/]+\/SKILL\.md$/.test(n.path)) {
      items.push({ action: 'move', from: n.path, to: `Skills/${base}/SKILL.md`, reason: 'Skills need the Skills/<name>/SKILL.md shape to sync to Claude and Codex.' });
      continue;
    }
    if (inFolder || n.path === 'CORE.md' || n.path === 'Inbox.md') continue;
    const lower = base.toLowerCase();
    const project = projects.find((p) => lower.includes(p.name) || lower.replace(/\s+/g, '').includes(p.name.replace(/\s+/g, '')));
    if (n.type === 'project') items.push({ action: 'move', from: n.path, to: `Projects/${n.title}.md`, reason: 'Frontmatter says type: project.' });
    else if (n.type === 'person') items.push({ action: 'move', from: n.path, to: `People/${n.title}.md`, reason: 'Frontmatter says type: person.' });
    else if (project) items.push({ action: 'merge', from: n.path, to: project.path, reason: `Looks like part of ${project.path.slice(9, -3)} — merge the current parts, archive the rest in Journal.` });
    else if (/(meeting|call|notes)/i.test(lower)) items.push({ action: 'move', from: n.path, to: `Journal/${name}`, reason: 'Meeting notes are history: keep them cold in Journal.' });
    else items.push({ action: 'move', from: n.path, to: `Areas/${name}`, reason: 'Loose note at the vault root; file it under an Area (or Inbox if it is a to-do).' });
  }
  for (const a of sizeAlerts(vault, cfg)) {
    items.push({ action: 'trim', from: a.path, to: a.kind === 'project' ? 'Journal/' : a.path, reason: `${a.tokens.toLocaleString()} tokens, cap ${a.cap.toLocaleString()} — move history to Journal and keep only current state.` });
  }
  return items;
}

export const CONSOLIDATION_PROMPT = `Weekly memory consolidation for the owner's vault. Use only the Jarvis MCP tools.
1. Review only the changed-note batch supplied by Jarvis, within its note budget. Do not scan the vault.
2. Find duplicates, facts that are no longer true, and history sitting in Projects/* that belongs in Journal.
3. For each change call save_memory with mode "replace" (full new note text) and a one-line reason. Move history into Journal/<year>-<project>-history.md with mode "append".
4. Keep CORE.md under 2,000 tokens and each project note under 3,000 tokens.
Never delete information outright; never edit Skills. Finish with a five-line summary of what you proposed.`;

export interface ConsolidationChange {
  content: string;
  reason: string;
}

/**
 * The next bounded batch of notes changed since the last consolidation, for the agent-run routine.
 * The checkpoint advances when the batch is handed out; anything unreviewed reappears once edited.
 */
export function nextConsolidationBatch(db: Db, noteBudget = 15): { paths: string[]; remaining: boolean } {
  const key = 'memory.consolidation.checkpoint';
  const checkpoint = getSetting(db, key, { mtime: -1, path: '' });
  const rows = all<{ path: string; mtime: number }>(db, `SELECT path, mtime FROM notes_index WHERE (mtime > ? OR (mtime = ? AND path > ?))
    AND lower(path) NOT LIKE 'skills/%' ORDER BY mtime, path LIMIT ?`, checkpoint.mtime, checkpoint.mtime, checkpoint.path, noteBudget + 1);
  const batch = rows.slice(0, noteBudget);
  const last = batch.at(-1);
  if (last) setSetting(db, key, { mtime: last.mtime, path: last.path });
  return { paths: batch.map((r) => r.path), remaining: rows.length > noteBudget };
}

/** Advance only after proposals are durable. A failed note is retried on the next run. */
export async function consolidateBatch(input: {
  db: Db;
  vault: VaultIndex;
  proposals: MemoryProposals;
  noteBudget?: number;
  review: (note: Note) => Promise<ConsolidationChange[]>;
}): Promise<{ reviewed: number; proposals: string[]; remaining: boolean; receipt: string }> {
  const { db, vault, proposals, review } = input;
  const key = 'memory.consolidation.checkpoint';
  const checkpoint = getSetting(db, key, { mtime: -1, path: '' });
  const budget = Math.max(1, Math.min(100, Math.floor(input.noteBudget || 10)));
  const notes = all<NoteRow>(db, `SELECT * FROM notes_index WHERE (mtime > ? OR (mtime = ? AND path > ?))
    AND lower(path) NOT LIKE 'skills/%' ORDER BY mtime, path LIMIT ?`, checkpoint.mtime, checkpoint.mtime, checkpoint.path, budget + 1);
  const ids: string[] = [];
  let reviewed = 0;
  for (const row of notes.slice(0, budget)) {
    const note = vault.read(row.path);
    if (note) {
      const changes = await review(note);
      if (vault.read(row.path)?.content !== note.content) throw new Error(`Note changed during consolidation: ${row.path}. Retry this batch.`);
      if (changes.length > 1) throw new Error('Consolidation must return at most one replacement per note.');
      for (const change of changes) {
        if (change.content === note.content) continue;
        const pending = proposals.list('pending').find((p) => p.target_path === row.path && p.content === change.content);
        const p = pending ?? proposals.propose({ target: row.path, content: change.content, reason: change.reason, mode: 'replace', autoApply: false });
        ids.push(p.id);
      }
      reviewed++;
    }
    setSetting(db, key, { mtime: row.mtime, path: row.path });
  }
  const remaining = notes.length > budget;
  const receipt = `Reviewed ${reviewed} changed notes; proposed ${ids.length} changes. ${remaining ? 'More notes remain for the next batch.' : 'Checkpoint saved; batch complete.'}`;
  setSetting(db, 'memory.consolidation.receipt', { reviewed, proposals: ids, remaining, receipt, at: new Date().toISOString() });
  return { reviewed, proposals: ids, remaining, receipt };
}
