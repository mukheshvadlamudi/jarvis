import type { RouterConfig } from '../config.ts';
import type { AgentId, AgentUsage, Task, UsageState } from '../types.ts';

export interface RouteDecision {
  agent: AgentId;
  reason: string;
  /** Set when both agents are over the threshold: keep queued until this time. */
  holdUntil?: string;
}

const other = (a: AgentId): AgentId => (a === 'claude' ? 'codex' : 'claude');
const label = (w: 'five_hour' | 'weekly') => (w === 'five_hour' ? '5h' : 'weekly');

/** Highest window of an agent at or over the threshold, if any. */
function exhaustedWindow(u: AgentUsage | undefined, threshold: number): { window: 'five_hour' | 'weekly'; pct: number; resetsAt: string | null } | null {
  if (!u) return null;
  let worst: { window: 'five_hour' | 'weekly'; pct: number; resetsAt: string | null } | null = null;
  for (const w of ['five_hour', 'weekly'] as const) {
    const win = u[w];
    if (win && win.usedPercent >= threshold && (!worst || win.usedPercent > worst.pct)) {
      worst = { window: w, pct: win.usedPercent, resetsAt: win.resetsAt };
    }
  }
  return worst;
}

function latestReset(u: AgentUsage, threshold: number): string | null {
  const times = (['five_hour', 'weekly'] as const)
    .map((w) => u[w])
    .filter((w) => w && w.usedPercent >= threshold && w.resetsAt)
    .map((w) => w!.resetsAt!) ;
  return times.sort().at(-1) ?? null;
}

/**
 * Pick an agent for a task (SPEC §6): explicit preference → scheduled → outward → effort override →
 * type default, then a usage check that falls back to the other agent when the chosen one is
 * at/over `fallbackAtPercent`. If both are exhausted, hold until the earliest reset.
 */
/** Highest known window of an agent; null when Claude/Codex has not reported yet. */
function load(u: AgentUsage | undefined): number | null {
  const vals = [u?.five_hour?.usedPercent, u?.weekly?.usedPercent].filter((v): v is number => typeof v === 'number');
  return vals.length ? Math.max(...vals) : null;
}

/** The agent with more plan room. Unknown usage counts as half full; a tie goes to Claude. */
export function headroomPick(usage: UsageState): { agent: AgentId; reason: string } {
  const c = load(usage.claude);
  const x = load(usage.codex);
  const agent: AgentId = (x ?? 50) < (c ?? 50) ? 'codex' : 'claude';
  const pct = (v: number | null) => (v === null ? 'unknown' : `${Math.round(v)}%`);
  return { agent, reason: `question → ${agent} (more room: Claude ${pct(c)}, Codex ${pct(x)})` };
}

/** A message that asks rather than instructs ("Is the fix safe?", "how do I…"). */
export const QUESTION = /\?\s*$|^\s*(what|how|why|when|where|who|which|should|can|could|would|is|are|was|were|do|does|did|will|explain|tell me)\b/i;

export function decide(task: Pick<Task, 'agent_pref' | 'schedule_id' | 'effort' | 'type' | 'outward'> & { mode?: Task['mode']; title?: string }, usage: UsageState, cfg: RouterConfig): RouteDecision {
  let agent: AgentId;
  let reason: string;
  let explicit = false;
  if (task.agent_pref === 'claude' || task.agent_pref === 'codex') {
    agent = task.agent_pref;
    reason = `you chose ${agent}`;
    explicit = true;
  } else if (task.schedule_id) {
    agent = cfg.scheduledTasks;
    reason = `scheduled tasks → ${agent}`;
  } else if (task.mode === 'chat' && ((task.type === 'other' && !task.outward) || (task.title !== undefined && QUESTION.test(task.title) && task.effort !== 'high'))) {
    // A plain question: answer from whichever plan has more room (or the agent the owner set).
    // Asking about "merge" or "send" is not an outward action; per-tool approvals still apply.
    if (cfg.chat === 'claude' || cfg.chat === 'codex') {
      agent = cfg.chat;
      reason = `questions → ${agent}`;
    } else {
      ({ agent, reason } = headroomPick(usage));
    }
  } else if (task.outward) {
    agent = 'claude';
    reason = 'outward action → claude (per-tool approvals)';
  } else if (cfg.effortOverride[task.effort]) {
    agent = cfg.effortOverride[task.effort]!;
    reason = `${task.effort} effort → ${agent}`;
  } else {
    agent = cfg.defaults[task.type] ?? 'codex';
    reason = `${task.type} → ${agent}`;
  }

  const threshold = cfg.fallbackAtPercent;
  const mine = exhaustedWindow(usage[agent], threshold);
  if (!mine) return { agent, reason };

  const alt = other(agent);
  const theirs = exhaustedWindow(usage[alt], threshold);
  const mineLabel = `${agent} ${label(mine.window)} at ${Math.round(mine.pct)}%`;
  if (!theirs && !explicit && !task.outward) {
    return { agent: alt, reason: `fallback: ${mineLabel}` };
  }
  if (!theirs && (explicit || task.outward)) {
    // Respect an explicit choice / approval-gated agent: wait for the reset instead of switching.
    const resets = latestReset(usage[agent], threshold);
    return { agent, reason: `waiting: ${mineLabel}${explicit ? ' (you chose it)' : ''}`, holdUntil: resets ?? new Date(Date.now() + 30 * 60_000).toISOString() };
  }
  const resets = [latestReset(usage[agent], threshold), latestReset(usage[alt], threshold)].filter(Boolean).sort() as string[];
  return {
    agent,
    reason: `waiting: both agents over ${threshold}% (${mineLabel}, ${alt} ${label(theirs!.window)} at ${Math.round(theirs!.pct)}%)`,
    holdUntil: resets[0] ?? new Date(Date.now() + 30 * 60_000).toISOString(),
  };
}
