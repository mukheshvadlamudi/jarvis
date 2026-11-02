import { cpSync, existsSync } from 'node:fs';
import type { Services } from '../app.ts';
import type { RunFinishedContext } from '../tasks/orchestrator.ts';
import { get } from '../db/index.ts';
import type { Project } from '../types.ts';
import { memoryContextProvider } from './context.ts';
import { MemoryProposals } from './proposals.ts';
import { VaultIndex } from './vault.ts';

export interface MemoryModule {
  vault: VaultIndex;
  proposals: MemoryProposals;
}

export function memoryOf(s: Services): MemoryModule {
  const m = s.modules.memory as MemoryModule | undefined;
  if (!m) throw new Error('memory module not set up');
  return m;
}

function hhmm(d = new Date()): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function dailyLine(ctx: RunFinishedContext, project: string | null, when = new Date()): string {
  const first = ctx.result.summary.replace(/\s+/g, ' ').trim();
  const brief = first.length > 140 ? `${first.slice(0, 137)}…` : first;
  const agent = ctx.run.agent === 'claude' ? 'Claude' : ctx.run.agent === 'codex' ? 'Codex' : ctx.run.agent;
  const label = ctx.result.status === 'done' ? '' : ctx.result.status === 'failed' ? 'Failed: ' : 'Cancelled: ';
  return `- ${hhmm(when)} ${label}${ctx.task.title}${brief && brief !== ctx.task.title ? ` — ${brief}` : ''} (${[agent, project].filter(Boolean).join(', ')})`;
}

export function setupMemory(s: Services): MemoryModule {
  if (s.env.vaultSource && !existsSync(s.env.vault)) cpSync(s.env.vaultSource, s.env.vault, { recursive: true });
  const vault = new VaultIndex(s.db, s.env.vault, s.bus);
  vault.indexAll();
  const proposals = new MemoryProposals(s.db, vault, s.bus, s.env.dataDir);
  const mod: MemoryModule = { vault, proposals };
  s.modules.memory = mod;

  s.orchestrator.context = memoryContextProvider(
    vault,
    () => (s.modules.skillList as (() => Array<{ name: string; description: string }>) | undefined)?.() ?? [],
    () => s.config.get(),
  );

  // Write-back: one line per finished task in today's daily note (auto-applied, low risk).
  s.orchestrator.afterRun.push((ctx) => {
    if (ctx.result.status === 'cancelled') return;
    const project = ctx.task.project_id ? get<Project>(s.db, 'SELECT name FROM projects WHERE id = ?', ctx.task.project_id)?.name ?? null : null;
    proposals.appendDailyLog(dailyLine(ctx, project), new Date(), ctx.run.id);
  });

  s.starters.push(() => vault.watch());
  s.closers.push(() => vault.close());
  return mod;
}
