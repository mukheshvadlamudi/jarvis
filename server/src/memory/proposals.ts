import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import type { Db } from '../db/index.ts';
import { all, get, run } from '../db/index.ts';
import type { EventBus } from '../events.ts';
import { newId, nowIso } from '../util/ids.ts';
import { unifiedDiff } from './diff.ts';
import type { VaultIndex } from './vault.ts';

export interface MemoryProposal {
  id: string;
  run_id: string | null;
  target_path: string;
  diff: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'applied' | 'failed';
  created_at: string;
  mode: 'append' | 'replace';
  content: string;
  base_hash: string | null;
  decided_at: string | null;
  error: string | null;
}

const hash = (s: string) => createHash('sha1').update(s).digest('hex');

/** Vault-relative path, normalised and lowercased, so './CORE.md' or 'core.md' can't skip the policy. */
export function policyKey(target: string): string {
  const t = posix.normalize(target.trim().replace(/\\/g, '/') || '.');
  return t.replace(/^(?:\.\/|\/)+/, '').toLowerCase();
}

/** Notes whose edits always need the owner's approval. */
export function needsApproval(target: string, mode: 'append' | 'replace'): boolean {
  const t = policyKey(target);
  if (t === 'core.md' || /^(projects|people|areas)\//.test(t)) return true;
  return mode === 'replace' && !t.startsWith('research/');
}

function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Memory write-back (SPEC §9). Agents never write the vault directly: `save_memory` creates a
 * proposal with a diff. Low-risk appends apply at once; CORE/Projects/People/Areas edits wait for
 * approval. Every applied change backs up the previous file under data/backups/<date>/.
 */
export class MemoryProposals {
  private db: Db;
  private vault: VaultIndex;
  private bus: EventBus;
  private backupDir: string;

  constructor(db: Db, vault: VaultIndex, bus: EventBus, dataDir: string) {
    this.db = db;
    this.vault = vault;
    this.bus = bus;
    this.backupDir = join(dataDir, 'backups');
  }

  normalizeTarget(target: string): string {
    let t = posix.normalize(target.trim().replace(/\\/g, '/') || '.').replace(/^(?:\.\/|\/)+/, '');
    if (!t || t === '.') t = 'Inbox.md';
    if (!t.toLowerCase().endsWith('.md')) t += '.md';
    if (t.toLowerCase().startsWith('skills/')) throw new Error('Skills are changed through skill proposals, not save_memory');
    this.vault.resolve(t); // throws if it escapes the vault
    return t;
  }

  private current(target: string): string {
    const abs = this.vault.resolve(target);
    return existsSync(abs) ? readFileSync(abs, 'utf8') : '';
  }

  private nextText(current: string, content: string, mode: 'append' | 'replace', target: string): string {
    if (mode === 'replace') return content.endsWith('\n') ? content : `${content}\n`;
    let base = current;
    if (!base && target.startsWith('Journal/DAILY/')) base = `# ${target.split('/').pop()!.replace(/\.md$/, '')}\n\n`;
    if (base && !base.endsWith('\n')) base += '\n';
    return `${base}${content.replace(/\n+$/, '')}\n`;
  }

  propose(input: { target: string; content: string; reason?: string; mode?: 'append' | 'replace'; runId?: string | null; autoApply?: boolean }): MemoryProposal {
    const target = this.normalizeTarget(input.target);
    const mode = input.mode ?? 'append';
    if (!input.content.trim()) throw new Error('content is empty');
    const current = this.current(target);
    const next = this.nextText(current, input.content, mode, target);
    const p: MemoryProposal = {
      id: newId('m'),
      run_id: input.runId ?? null,
      target_path: target,
      diff: unifiedDiff(current, next, target),
      reason: input.reason?.trim() || '',
      status: 'pending',
      created_at: nowIso(),
      mode,
      content: input.content,
      base_hash: hash(current),
      decided_at: null,
      error: null,
    };
    run(
      this.db,
      `INSERT INTO memory_proposals (id, run_id, target_path, diff, reason, status, created_at, mode, content, base_hash)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      p.id, p.run_id, p.target_path, p.diff, p.reason, p.created_at, p.mode, p.content, p.base_hash,
    );
    const auto = input.autoApply ?? !needsApproval(target, mode);
    if (auto) return this.apply(p.id, 'auto');
    this.bus.publish('memory.proposal', p);
    return p;
  }

  appendDailyLog(line: string, when = new Date(), runId: string | null = null): MemoryProposal {
    return this.propose({ target: `Journal/DAILY/${localDate(when)}.md`, content: line, reason: 'Daily log', mode: 'append', runId, autoApply: true });
  }

  get(id: string): MemoryProposal | undefined {
    return get<MemoryProposal>(this.db, 'SELECT * FROM memory_proposals WHERE id = ?', id);
  }

  list(status?: string, limit = 200): MemoryProposal[] {
    if (status) return all<MemoryProposal>(this.db, 'SELECT * FROM memory_proposals WHERE status = ? ORDER BY created_at DESC LIMIT ?', status, limit);
    return all<MemoryProposal>(this.db, 'SELECT * FROM memory_proposals ORDER BY created_at DESC LIMIT ?', limit);
  }

  pendingCount(): number {
    return get<{ n: number }>(this.db, "SELECT COUNT(*) AS n FROM memory_proposals WHERE status = 'pending'")?.n ?? 0;
  }

  decide(id: string, decision: 'approved' | 'rejected'): MemoryProposal {
    const p = this.get(id);
    if (!p) throw new Error('not_found');
    if (p.status !== 'pending') throw new Error(`proposal is already ${p.status}`);
    if (decision === 'rejected') {
      run(this.db, "UPDATE memory_proposals SET status = 'rejected', decided_at = ? WHERE id = ?", nowIso(), id);
      const r = this.get(id)!;
      this.bus.publish('memory.proposal', r);
      return r;
    }
    return this.apply(id, 'owner');
  }

  /** Apply a proposal: backup, write atomically, reindex. Replace-mode fails if the note changed since. */
  private apply(id: string, via: 'auto' | 'owner'): MemoryProposal {
    const p = this.get(id)!;
    const abs = this.vault.resolve(p.target_path);
    const current = this.current(p.target_path);
    if (p.mode === 'replace' && p.base_hash && hash(current) !== p.base_hash) {
      run(this.db, "UPDATE memory_proposals SET status = 'failed', decided_at = ?, error = ? WHERE id = ?", nowIso(), 'The note changed after this proposal was made. Ask the agent to propose again.', id);
      const r = this.get(id)!;
      this.bus.publish('memory.proposal', r);
      return r;
    }
    const next = this.nextText(current, p.content, p.mode, p.target_path);
    if (existsSync(abs) && via === 'owner') {
      const dest = join(this.backupDir, localDate(), p.target_path);
      mkdirSync(dirname(dest), { recursive: true });
      if (!existsSync(dest)) copyFileSync(abs, dest);
    }
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = `${abs}.jarvis-tmp`;
    writeFileSync(tmp, next);
    renameSync(tmp, abs);
    this.vault.indexFile(p.target_path);
    run(this.db, "UPDATE memory_proposals SET status = 'applied', decided_at = ? WHERE id = ?", nowIso(), id);
    const r = this.get(id)!;
    this.bus.publish('memory.proposal', r);
    this.bus.publish('memory.updated', { changed: 1, paths: [p.target_path] });
    return r;
  }
}
