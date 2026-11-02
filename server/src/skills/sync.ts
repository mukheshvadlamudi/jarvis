import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso } from '../util/ids.ts';
import type { Db } from '../db/index.ts';
import { run } from '../db/index.ts';
import type { SkillRegistry } from './registry.ts';
import { skillHash } from './registry.ts';

const MANIFEST = '.jarvis-manifest.json';

interface Manifest {
  managed: Record<string, { hash: string; syncedAt: string }>;
}

export interface SyncAction {
  target: 'claude' | 'codex';
  skill: string;
  action: 'add' | 'update' | 'remove' | 'unchanged' | 'skip';
  reason?: string;
}

export interface SyncResult {
  dryRun: boolean;
  actions: SyncAction[];
  targets: Record<'claude' | 'codex', string>;
}

function readManifest(dir: string): Manifest {
  try {
    return JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) as Manifest;
  } catch {
    return { managed: {} };
  }
}

/**
 * Copy (not symlink — Windows) each enabled vault skill into the Claude and Codex skill folders.
 * A manifest per target records what Jarvis created, so it only updates/removes its own skills and
 * never touches skills the owner installed by hand (or anything else under ~/.claude / ~/.codex).
 */
export function syncSkills(registry: SkillRegistry, db: Db, targets: Record<'claude' | 'codex', string>, opts: { dryRun?: boolean } = {}): SyncResult {
  const dryRun = opts.dryRun ?? false;
  const actions: SyncAction[] = [];
  const enabled = registry.enabled();
  for (const target of ['claude', 'codex'] as const) {
    const dir = targets[target];
    const manifest = readManifest(dir);
    const wanted = new Set<string>();
    for (const s of enabled) {
      const srcDir = join(registry.vault, s.path.replace(/\/SKILL\.md$/, ''));
      if (!existsSync(join(srcDir, 'SKILL.md'))) continue;
      wanted.add(s.name);
      const dest = join(dir, s.name);
      const hash = skillHash(readFileSync(join(srcDir, 'SKILL.md'), 'utf8'));
      const mine = manifest.managed[s.name];
      if (existsSync(dest) && !mine) {
        actions.push({ target, skill: s.name, action: 'skip', reason: 'a skill with this name already exists and was not created by Jarvis' });
        continue;
      }
      const action: SyncAction['action'] = !mine ? 'add' : mine.hash !== hash || !existsSync(dest) ? 'update' : 'unchanged';
      actions.push({ target, skill: s.name, action });
      if (!dryRun && action !== 'unchanged') {
        mkdirSync(dir, { recursive: true });
        rmSync(dest, { recursive: true, force: true });
        cpSync(srcDir, dest, { recursive: true });
        manifest.managed[s.name] = { hash, syncedAt: nowIso() };
      }
    }
    for (const name of Object.keys(manifest.managed)) {
      if (wanted.has(name)) continue;
      actions.push({ target, skill: name, action: 'remove', reason: 'disabled or deleted in the vault' });
      if (!dryRun) {
        rmSync(join(dir, name), { recursive: true, force: true });
        delete manifest.managed[name];
      }
    }
    if (!dryRun && (Object.keys(manifest.managed).length || existsSync(join(dir, MANIFEST)))) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, MANIFEST), JSON.stringify(manifest, null, 2));
    }
  }
  if (!dryRun) {
    const at = nowIso();
    for (const s of enabled) run(db, 'UPDATE skills SET synced_at = ? WHERE id = ?', at, s.id);
  }
  return { dryRun, actions, targets };
}

/** Per-skill sync state for the UI without changing anything. */
export function syncStatus(registry: SkillRegistry, db: Db, targets: Record<'claude' | 'codex', string>): Record<string, Record<'claude' | 'codex', SyncAction['action']>> {
  const plan = syncSkills(registry, db, targets, { dryRun: true });
  const out: Record<string, Record<'claude' | 'codex', SyncAction['action']>> = {};
  for (const a of plan.actions) {
    out[a.skill] ??= { claude: 'unchanged', codex: 'unchanged' };
    out[a.skill][a.target] = a.action;
  }
  return out;
}

export function listTargetSkills(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
