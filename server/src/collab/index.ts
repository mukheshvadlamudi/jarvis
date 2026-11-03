import { existsSync } from 'node:fs';
import type { Services } from '../app.ts';
import { all, get, run } from '../db/index.ts';
import type { RunFinishedContext } from '../tasks/orchestrator.ts';
import type { Workdir } from '../tasks/workdir.ts';
import type { AgentId, Run, Task } from '../types.ts';
import { logger } from '../util/log.ts';

const log = logger('collab');

export type HandoffMode = 'review' | 'continue';

/** Planned on a task: what to do when it finishes. */
export interface HandoffSpec {
  agent: 'other' | AgentId;
  mode: HandoffMode;
  instructions?: string;
}

/** Stored on the task a handoff created. */
export interface HandoffOrigin {
  fromTask: string;
  fromRun: string;
  fromAgent: string;
  mode: HandoffMode;
  cwd: string;
}

/** Longest Claude ⇄ Codex handoff chain from one task, so two agents can't ping-pong away a plan. */
export const MAX_HANDOFF_CHAIN = 3;

const otherAgent = (a: string): AgentId => (a === 'claude' ? 'codex' : 'claude');
const label = (a: string) => (a === 'claude' ? 'Claude' : a === 'codex' ? 'Codex' : a);

export function consultPrompt(from: string, question: string, context: string): string {
  return `[jarvis:consult] ${label(from)} is working on a task and asks you, ${label(otherAgent(from))}, for a second opinion.
You are read-only: you may read files in the current folder, but do not change anything and do not use outward tools.
Answer directly and concisely (under 250 words). If you disagree, say so and why.

Question:
${question.trim()}
${context.trim() ? `\nContext from ${label(from)}:\n${context.trim().slice(0, 6000)}` : ''}`;
}

/**
 * Agent collaboration (Claude ⇄ Codex):
 * - consult: one agent asks the other a question mid-task (short read-only side run, capped per task);
 * - handoff: when a task finishes, a linked task is queued for the other agent to review or continue.
 */
export class Collaboration {
  private s: Services;

  constructor(s: Services) {
    this.s = s;
  }

  consultsUsed(taskId: string): number {
    return get<{ n: number }>(this.s.db, "SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND purpose = 'consult'", taskId)?.n ?? 0;
  }

  async consult(ctx: { runId: string; taskId: string }, question: string, context = ''): Promise<{ ok: boolean; text: string }> {
    const cfg = this.s.config.get();
    if (!question.trim()) return { ok: false, text: 'Ask a specific question.' };
    const asking = get<Run>(this.s.db, 'SELECT * FROM runs WHERE id = ?', ctx.runId);
    if (!asking) return { ok: false, text: 'Unknown run.' };
    const from = asking.agent === 'codex' ? 'codex' : 'claude';
    const to = otherAgent(from);
    const used = this.consultsUsed(ctx.taskId);
    if (used >= cfg.collaboration.maxConsultsPerTask) {
      return { ok: false, text: `Consult limit reached (${cfg.collaboration.maxConsultsPerTask} per task). Continue with your own judgement.` };
    }
    const u = this.s.usage.current()[to];
    const hot = [u.five_hour, u.weekly].find((w) => w && w.usedPercent >= cfg.router.fallbackAtPercent);
    if (hot) return { ok: false, text: `${label(to)} is at ${Math.round(hot.usedPercent)}% of its plan window — not consulting. Continue on your own.` };

    this.s.orchestrator.recordEvent(ctx.taskId, ctx.runId, { kind: 'status', payload: { status: 'consult', phase: 'asked', from, to, question } });
    const r = await this.s.orchestrator.sideRun(ctx.taskId, {
      purpose: 'consult', parentRunId: ctx.runId,
      agent: to,
      prompt: consultPrompt(from, question, context),
      resumeSessionId: null,
      cwd: existsSync(asking.cwd) ? asking.cwd : this.s.env.dataDir,
      label: `consult: ${label(from)} asked ${label(to)}`,
    });
    const answer = r.status === 'done' ? r.summary.trim() : `(${label(to)} could not answer: ${r.error ?? r.status})`;
    this.s.orchestrator.recordEvent(ctx.taskId, ctx.runId, { kind: 'status', payload: { status: 'consult', phase: 'answered', from, to, question, answer } });
    return { ok: r.status === 'done', text: r.status === 'done' ? `${label(to)} says:\n${answer}` : answer };
  }

  /** How many handoffs led to this task (0 for a task the owner created). */
  handoffDepth(task: Task): number {
    let depth = 0;
    let t: Task | null = task;
    while (t?.handoff_json && t.parent_id && depth <= MAX_HANDOFF_CHAIN) {
      depth++;
      t = this.s.tasks.get(t.parent_id) ?? null;
    }
    return depth;
  }

  /** Create the follow-on task for the other (or a named) agent from a finished run. */
  createHandoff(from: Task, fromRun: Run, spec: HandoffSpec): Task {
    if (this.handoffDepth(from) >= MAX_HANDOFF_CHAIN) throw new Error(`Handoff limit reached (${MAX_HANDOFF_CHAIN} in a row). Start a new task to go further.`);
    const agent: AgentId = spec.agent === 'other' ? otherAgent(fromRun.agent) : spec.agent;
    const files = all<{ payload_json: string }>(this.s.db, "SELECT payload_json FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE task_id = ?) AND kind = 'file_change'", from.id)
      .map((e) => (JSON.parse(e.payload_json) as { path?: string }).path)
      .filter((p): p is string => !!p);
    const uniqueFiles = [...new Set(files)].slice(0, 40);
    const verb = spec.mode === 'review' ? 'Review' : 'Continue';
    const lines = [
      spec.instructions?.trim() ||
        (spec.mode === 'review'
          ? `Review the work ${label(fromRun.agent)} just finished. Check correctness, edge cases and anything it missed. Do not rewrite it; list concrete issues (most important first) and say clearly if it is good to ship.`
          : `Continue the work ${label(fromRun.agent)} started. Build on what is already there.`),
      '',
      `## What ${label(fromRun.agent)} did`,
      from.result_summary ?? '(no summary)',
      uniqueFiles.length ? `\nFiles it changed:\n${uniqueFiles.map((f) => `- ${f}`).join('\n')}` : '',
      `\nWorking folder: ${fromRun.cwd}${spec.mode === 'review' ? ' (you are read-only here)' : ''}`,
      `Original task: ${from.title}${from.body ? `\n${from.body}` : ''}`,
    ];
    const origin: HandoffOrigin = { fromTask: from.id, fromRun: fromRun.id, fromAgent: fromRun.agent, mode: spec.mode, cwd: fromRun.cwd };
    const t = this.s.tasks.create({
      title: `${verb}: ${from.title}`.slice(0, 300),
      body: lines.filter((l) => l !== '').join('\n'),
      type: from.type,
      project_id: from.project_id,
      agent_pref: agent,
      effort: from.effort,
      parent_id: from.id,
      handoff: origin,
      outward: false,
      run: true,
    });
    run(this.s.db, 'UPDATE tasks SET then_json = NULL WHERE id = ?', from.id);
    this.s.bus.publish('task.updated', this.s.tasks.get(from.id));
    this.s.orchestrator.tick();
    return t;
  }

  /** Hand off now (task already has a finished run) or after the current run. */
  request(taskId: string, spec: HandoffSpec): { mode: 'now' | 'after'; task?: Task } {
    const t = this.s.tasks.get(taskId);
    if (!t) throw new Error('not_found');
    if (this.handoffDepth(t) >= MAX_HANDOFF_CHAIN) throw new Error(`Handoff limit reached (${MAX_HANDOFF_CHAIN} in a row). Start a new task to go further.`);
    const last = get<Run>(this.s.db, "SELECT * FROM runs WHERE task_id = ? AND purpose IN ('user_reply', 'handoff') AND visibility = 'conversation' ORDER BY started_at DESC LIMIT 1", taskId);
    if (last && last.status !== 'running' && t.status === 'done') return { mode: 'now', task: this.createHandoff(t, last, spec) };
    this.s.tasks.patch(taskId, { then_json: JSON.stringify(spec) });
    return { mode: 'after' };
  }

  afterRun = (ctx: RunFinishedContext): void => {
    if (ctx.result.status !== 'done' || !ctx.task.then_json) return;
    try {
      this.createHandoff(this.s.tasks.get(ctx.task.id) ?? ctx.task, ctx.run, JSON.parse(ctx.task.then_json) as HandoffSpec);
    } catch (err) {
      log.warn(`handoff from ${ctx.task.id} failed`, err);
    }
  };

  /** Review handoffs run in the original folder; continue handoffs too when it still exists. */
  workdir = (task: Task): Workdir | null => {
    if (!task.handoff_json) return null;
    const o = JSON.parse(task.handoff_json) as HandoffOrigin;
    return existsSync(o.cwd) ? { cwd: o.cwd, kind: o.cwd.includes('.jarvis-worktrees') ? 'worktree' : 'scratch' } : null;
  };

  input = (task: Task, input: { sandbox: 'read-only' | 'workspace-write' }): void => {
    if (!task.handoff_json) return;
    const o = JSON.parse(task.handoff_json) as HandoffOrigin;
    if (o.mode === 'review') input.sandbox = 'read-only';
  };
}

export function collabOf(s: Services): Collaboration {
  const c = s.modules.collab as Collaboration | undefined;
  if (!c) throw new Error('collaboration module not set up');
  return c;
}

export function setupCollaboration(s: Services): Collaboration {
  const c = new Collaboration(s);
  s.orchestrator.afterRun.push(c.afterRun);
  s.orchestrator.workdirHooks.push(c.workdir);
  s.orchestrator.inputHooks.push(c.input);
  // Optional: every finished code task gets an automatic review by the other agent.
  s.orchestrator.afterRun.push((ctx) => {
    if (!s.config.get().collaboration.autoHandoffReview || ctx.result.status !== 'done') return;
    if (ctx.task.type !== 'code' || ctx.task.handoff_json || ctx.task.then_json) return;
    if (ctx.run.purpose !== 'user_reply') return;
    try {
      c.createHandoff(ctx.task, ctx.run, { agent: 'other', mode: 'review' });
    } catch (err) {
      log.warn('auto review handoff failed', err);
    }
  });
  s.modules.collab = c;
  return c;
}
