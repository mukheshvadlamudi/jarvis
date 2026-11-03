import type { ApprovalService } from '../approvals/service.ts';
import type { ConfigStore } from '../config.ts';
import type { Db } from '../db/index.ts';
import { all, get, run } from '../db/index.ts';
import type { EventBus } from '../events.ts';
import { decide } from '../router/index.ts';
import type { RunnerRegistry } from '../runners/index.ts';
import { activityLine } from '../runners/activity.ts';
import type { McpServerSpec, NormalizedEvent, RunEventSink, RunHandle, RunInput, RunResult } from '../runners/types.ts';
import type { AgentId, Approval, Attachment, Effort, Project, Run, RunPurpose, RunVisibility, StoredRunEvent, Task } from '../types.ts';
import type { UsageMeter } from '../usage/meter.ts';
import { newId, nowIso } from '../util/ids.ts';
import { logger } from '../util/log.ts';
import { capPayload } from '../util/truncate.ts';
import type { ContextProvider } from './context.ts';
import type { TaskService } from './service.ts';
import { prepareWorkdir } from './workdir.ts';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Workdir } from './workdir.ts';

const log = logger('orchestrator');

/** Per-message choices from the Ask composer. Omitted fields fall back to routing and Settings. */
export interface AskOptions {
  agent?: AgentId;
  /** A model id the agent's CLI offers; 'default' or empty = the plan default. */
  model?: string;
  effort?: Effort;
  /** Upload ids (see the uploads table). */
  attachments?: string[];
}

interface StartOptions extends AskOptions {
  prompt: string;
  ownerText?: string;
  resumeSessionId?: string;
  /** Overrides the route reason shown on the run. */
  reason?: string;
  /** Use `agent` as given (a limit handover), instead of routing. */
  forceAgent?: boolean;
}

/** An agent stopped because its plan window is used up (Claude and Codex wording, plus HTTP 429). */
export const LIMIT_ERROR = /usage limit|rate[_ ]?limit|limit (?:reached|exceeded)|hit your (?:usage )?limit|out of (?:usage|credits)|quota|too many requests|\b429\b/i;

/** Added to a conversation's context so agents answer like an assistant, not a batch job. */
const CHAT_GUIDE = `

## This is a live conversation
The owner is chatting with you in Jarvis and sees your reply as you write it. Answer directly in Markdown and keep it as short as the question allows. For a simple question just answer; use tools (files, shell, web, the owner's notes through the jarvis tools) only when the request needs them. If you need something from the owner, ask one clear question.`;

const ANSWER_CAP = 12_000;
const HISTORY_CAP = 14_000;
/** Marks the new message inside a prompt that also carries the conversation so far. */
export const NEW_MESSAGE = '\n\n---\n\nNew message from the owner:\n';

export interface RunFinishedContext {
  task: Task;
  run: Run;
  result: RunResult;
  workdir: Workdir;
}

export interface OrchestratorDeps {
  db: Db;
  bus: EventBus;
  tasks: TaskService;
  approvals: ApprovalService;
  usage: UsageMeter;
  runners: RunnerRegistry;
  config: ConfigStore;
  dataDir: string;
  vaultPath?: string;
  context: ContextProvider;
}

interface Active {
  taskId: string;
  runId: string;
  handle: RunHandle;
  agent: AgentId;
  visibility: RunVisibility;
}

/**
 * Owns the queue: picks queued tasks up to `maxConcurrentRuns`, routes them, prepares a working
 * folder and context, streams runner events into `run_events` + the bus, and finishes tasks.
 */
export class Orchestrator {
  private d: OrchestratorDeps;
  private active = new Map<string, Active>();
  private starting = new Set<string>();
  private wakeTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Hooks other modules attach to (daily log line, learning loop, research write-back…). */
  readonly afterRun: Array<(ctx: RunFinishedContext) => Promise<void> | void> = [];
  /** Supplies MCP servers (the Jarvis MCP) for a run; set by the MCP module. */
  mcpProvider: ((runId: string, taskId: string) => Record<string, McpServerSpec>) | null = null;
  /** Adjusts run input per task (e.g. research enables web search); set by workspaces. */
  readonly inputHooks: Array<(task: Task, input: RunInput) => void> = [];
  /** Lets a module choose the working folder (e.g. a review handoff reuses the original worktree). */
  readonly workdirHooks: Array<(task: Task) => Workdir | null> = [];
  context: ContextProvider;

  constructor(deps: OrchestratorDeps) {
    this.d = deps;
    this.context = deps.context;
    deps.approvals.onOrphanDecision = (a, decision, note) => this.onOrphanDecision(a, decision, note);
  }

  /** Mark runs that were alive when the server stopped as failed. */
  recover(): void {
    const stale = all<Run>(this.d.db, "SELECT * FROM runs WHERE status = 'running'");
    for (const r of stale) {
      run(this.d.db, "UPDATE runs SET status = 'failed', ended_at = ?, error = ? WHERE id = ?", nowIso(), 'Jarvis stopped while this run was active', r.id);
      const t = this.d.tasks.get(r.task_id);
      if (t && t.status === 'running') {
        this.d.tasks.setStatus(t.id, 'failed', { result_summary: 'Interrupted: Jarvis stopped during this run. Re-run or send a follow-up to resume the session.' });
      }
    }
    if (stale.length) log.info(`recovered ${stale.length} interrupted run(s)`);
  }

  activeCount(): number {
    return this.active.size + [...this.starting].filter((id) => !this.active.has(id)).length;
  }

  isActive(taskId: string, includeInternal = true): boolean {
    return [...this.active.values()].some((a) => a.taskId === taskId && (includeInternal || a.visibility !== 'internal')) || this.starting.has(taskId);
  }

  activeRuns(): Array<{ taskId: string; runId: string; agent: AgentId; visibility: RunVisibility }> {
    return [...this.active.values()].map(({ taskId, runId, agent, visibility }) => ({ taskId, runId, agent, visibility }));
  }

  stop(): void {
    this.stopped = true;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
  }

  /** Stop taking work, cancel live runs and wait for them to settle. */
  async shutdown(): Promise<void> {
    this.stop();
    const live = [...this.active.values()];
    await Promise.all(live.map((a) => a.handle.cancel().catch(() => undefined)));
    await Promise.all(live.map((a) => a.handle.done.catch(() => undefined)));
    await new Promise((r) => setTimeout(r, 0));
  }

  /** Fill free slots from the queue. Safe to call often. */
  tick(): void {
    if (this.stopped) return;
    const max = this.d.config.get().maxConcurrentRuns;
    while (this.activeCount() < max) {
      const next = this.d.tasks.nextQueued([...this.active.values()].map((a) => a.taskId).concat([...this.starting]));
      if (!next) break;
      this.starting.add(next.id);
      void this.startRun(next, { prompt: this.promptFor(next) }).finally(() => this.starting.delete(next.id));
    }
    this.scheduleWake();
  }

  /** Wake up when the earliest held task (waiting for a usage reset) becomes eligible. */
  private scheduleWake(): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    const row = get<{ t: string | null }>(this.d.db, "SELECT MIN(not_before) AS t FROM tasks WHERE status = 'queued' AND not_before IS NOT NULL");
    if (!row?.t) return;
    const ms = Math.max(1000, Date.parse(row.t) - Date.now() + 1000);
    this.wakeTimer = setTimeout(() => this.tick(), Math.min(ms, 2 ** 31 - 1));
    this.wakeTimer.unref();
  }

  private promptFor(task: Task): string {
    return task.body ? `${task.title}\n\n${task.body}` : task.title;
  }

  /** Queue a task (from inbox/done/failed) and try to start it. */
  enqueue(taskId: string): Task {
    const t = this.d.tasks.get(taskId);
    if (!t) throw new Error('not_found');
    if (this.isActive(taskId)) throw new Error('task is already running');
    const updated = t.status === 'queued' ? this.d.tasks.setStatus(taskId, 'queued', { not_before: null }) : this.d.tasks.move(taskId, 'queued');
    this.tick();
    return this.d.tasks.get(taskId) ?? updated;
  }

  async cancel(taskId: string): Promise<Task> {
    const live = [...this.active.values()].filter((a) => a.taskId === taskId);
    if (live.length) {
      await Promise.all(live.map(async (a) => {
        const cancellation = a.handle.cancel();
        this.d.approvals.abandonRun(a.runId, 'Run cancelled');
        await cancellation;
      }));
      return this.d.tasks.get(taskId)!;
    }
    const t = this.d.tasks.get(taskId);
    if (!t) throw new Error('not_found');
    for (const ap of all<Approval>(this.d.db, "SELECT * FROM approvals WHERE task_id = ? AND status = 'pending'", taskId)) {
      this.d.approvals.decide(ap.id, 'rejected', 'Task cancelled', 'cancel');
    }
    const fresh = this.d.tasks.get(taskId)!;
    if (fresh.status === 'cancelled') return fresh;
    return this.d.tasks.setStatus(taskId, 'cancelled');
  }

  /**
   * Send a follow-up. A live run that supports it gets the text directly; otherwise a new run
   * resumes the last session with the follow-up as its prompt.
   */
  async followUp(taskId: string, text: string, opts: AskOptions = {}): Promise<{ mode: 'live' | 'resumed' | 'queued'; runId?: string }> {
    const a = this.active.get(taskId);
    if (a?.handle.sendFollowUp) {
      await a.handle.sendFollowUp(text);
      return { mode: 'live', runId: a.runId };
    }
    if (a) throw new Error('this run cannot take follow-ups while active; wait for it to finish or stop it');
    const t = this.d.tasks.get(taskId);
    if (!t) throw new Error('not_found');
    // Conversations answer at once: the owner is waiting, so they do not queue behind background tasks.
    if (t.mode === 'chat') return this.ask(taskId, text, opts);
    const last = this.lastRun(taskId);
    if (this.activeCount() >= this.d.config.get().maxConcurrentRuns) {
      // Fold the follow-up into the body and queue it; the next run picks it up.
      this.d.tasks.patch(taskId, { body: `${t.body ? `${t.body}\n\n` : ''}Follow-up: ${text}` });
      if (t.status !== 'queued') this.d.tasks.move(taskId, 'queued');
      return { mode: 'queued' };
    }
    if (t.status !== 'queued') this.d.tasks.setStatus(taskId, 'queued');
    this.starting.add(taskId);
    try {
      const runId = await this.startRun(this.d.tasks.get(taskId)!, {
        prompt: text,
        ownerText: text,
        resumeSessionId: last?.session_id ?? undefined,
        agent: (last?.agent as AgentId) ?? undefined,
      });
      return { mode: 'resumed', runId: runId ?? undefined };
    } finally {
      this.starting.delete(taskId);
    }
  }

  /** The newest main run of a task (side runs such as second opinions are skipped). */
  private lastRun(taskId: string): Run | undefined {
    return get<Run>(
      this.d.db,
      `SELECT * FROM runs WHERE task_id = ? AND purpose IN ('user_reply', 'handoff') AND visibility = 'conversation'
       ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      taskId,
    );
  }

  /**
   * Send one message in a conversation and start answering now. The agent is the owner's pick, else
   * the one that answered last (a follow-up stays put), else the router. Switching agents starts a
   * fresh session that is handed the conversation so far.
   */
  async ask(taskId: string, text: string, opts: AskOptions = {}): Promise<{ mode: 'resumed'; runId?: string }> {
    if (this.isActive(taskId, false)) throw new Error('Jarvis is still answering the last message; wait for it or stop it');
    const t = this.d.tasks.get(taskId);
    if (!t) throw new Error('not_found');
    const last = this.lastRun(taskId);
    // Stay with the agent that answered last; a voice turn (Gemini) is not an agent, so route normally.
    const lastAgent = last?.agent === 'claude' || last?.agent === 'codex' ? last.agent : undefined;
    const agent = opts.agent ?? lastAgent;
    const contaminated = last?.session_id && get(this.d.db, "SELECT id FROM runs WHERE task_id = ? AND session_id = ? AND visibility = 'internal' LIMIT 1", taskId, last.session_id);
    const same = !!last && last.agent === agent && !!last.session_id && !contaminated;
    if (t.status !== 'queued') this.d.tasks.setStatus(taskId, 'queued', { not_before: null });
    this.starting.add(taskId);
    try {
      const runId = await this.startRun(this.d.tasks.get(taskId)!, {
        ...opts,
        ownerText: text,
        agent,
        prompt: same || !last ? text : `${this.history(taskId)}${NEW_MESSAGE}${text}`,
        resumeSessionId: same ? last!.session_id! : undefined,
        reason: opts.agent ? `you chose ${opts.agent}` : last ? (same ? `follow-up stays with ${agent}` : `continues with ${agent}`) : undefined,
      });
      return { mode: 'resumed', runId: runId ?? undefined };
    } finally {
      this.starting.delete(taskId);
    }
  }

  /** The conversation so far as plain text, for an agent joining it (newest kept when long). */
  history(taskId: string): string {
    const runs = all<Run>(this.d.db, "SELECT * FROM runs WHERE task_id = ? AND status = 'done' AND visibility = 'conversation' AND purpose IN ('user_reply', 'both', 'second_opinion', 'handoff') ORDER BY started_at, rowid", taskId);
    const who = (r: Run) => {
      const name = r.agent === 'claude' ? 'Claude' : r.agent === 'codex' ? 'Codex' : r.agent === 'gemini' ? 'Jarvis (voice)' : r.agent;
      return r.purpose === 'both' || r.purpose === 'second_opinion' ? `${name} (${r.purpose})` : name;
    };
    const turns: string[] = [];
    for (const r of runs) {
      const asked = r.owner_text;
      if (asked && r.purpose === 'user_reply') turns.push(`Owner: ${asked}`);
      if (r.answer) turns.push(`${who(r)}: ${r.answer}`);
    }
    let text = turns.join('\n\n');
    if (text.length > HISTORY_CAP) text = `…${text.slice(-HISTORY_CAP)}`;
    return `Earlier in this conversation (you are joining it; earlier replies may be from the other agent):\n\n${text}`;
  }

  /** Copy the chosen uploads into the run folder so the agent can open them like any file. */
  private attach(ids: string[] | undefined, cwd: string): Attachment[] {
    if (!ids?.length) return [];
    const dir = join(cwd, 'attachments');
    const out: Attachment[] = [];
    for (const id of ids.slice(0, 10)) {
      const u = get<{ id: string; name: string; mime: string; size: number; path: string }>(this.d.db, 'SELECT * FROM uploads WHERE id = ?', id);
      if (!u || !existsSync(u.path)) continue;
      mkdirSync(dir, { recursive: true });
      let dest = join(dir, basename(u.name));
      if (existsSync(dest)) dest = join(dir, `${id}-${basename(u.name)}`);
      copyFileSync(u.path, dest);
      out.push({ id: u.id, name: u.name, mime: u.mime, size: u.size, path: dest });
    }
    return out;
  }

  private onOrphanDecision(a: Approval, decision: 'approved' | 'rejected', note: string | null): void {
    if (!a.task_id) return;
    const t = this.d.tasks.get(a.task_id);
    if (!t || this.isActive(t.id)) return;
    if (decision === 'approved') {
      const text = `The owner approved: ${a.summary}.${note ? ` Note: ${note}.` : ''} Go ahead with exactly that action, then finish the task.`;
      void this.followUp(t.id, text).catch((err) => log.warn(`could not resume ${t.id} after approval`, err));
    } else if (t.status === 'needs_you') {
      this.d.tasks.setStatus(t.id, 'needs_you', { result_summary: `You rejected: ${a.summary}${note ? ` — ${note}` : ''}` });
    }
  }

  private async startRun(task: Task, opts: StartOptions): Promise<string | null> {
    const cfg = this.d.config.get();
    let agent: AgentId;
    let reason: string;
    if (opts.agent && (opts.resumeSessionId || task.mode === 'chat' || opts.forceAgent)) {
      agent = opts.agent;
      reason = opts.reason ?? `follow-up resumes ${agent} session`;
    } else {
      const decision = decide(task, this.d.usage.current(), cfg.router);
      if (decision.holdUntil) {
        this.d.tasks.setStatus(task.id, 'queued', { route_reason: decision.reason, not_before: decision.holdUntil, agent: decision.agent });
        this.scheduleWake();
        return null;
      }
      agent = decision.agent;
      reason = decision.reason;
    }

    const project = task.project_id ? get<Project>(this.d.db, 'SELECT * FROM projects WHERE id = ?', task.project_id) : undefined;
    let workdir: Workdir;
    let ctx;
    try {
      workdir = this.workdirHooks.map((h) => h(task)).find((w) => w) ?? (await prepareWorkdir(task, project, this.d.dataDir));
      ctx = await this.context.build(task, project);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.d.tasks.setStatus(task.id, 'running', { agent, route_reason: reason });
      this.d.tasks.setStatus(task.id, 'failed', { result_summary: `Could not prepare the run: ${message}` });
      return null;
    }

    const runId = newId('r');
    const startedAt = nowIso();
    const attachments = this.attach(opts.attachments, workdir.cwd);
    const effort = opts.effort ?? task.effort;
    const model = opts.model && opts.model !== 'default' ? opts.model : cfg.agents[agent].model || undefined;
    const maintenance = task.schedule_id && get(this.d.db, "SELECT id FROM schedules WHERE id = ? AND (built_in = 'memory_consolidation' OR json_extract(task_template_json, '$.routine') = 'memory_consolidation')", task.schedule_id);
    const purpose: RunPurpose = task.handoff_json ? 'handoff' : maintenance ? 'maintenance' : 'user_reply';
    const visibility: RunVisibility = purpose === 'maintenance' ? 'internal' : 'conversation';
    run(
      this.d.db,
      `INSERT INTO runs (id, task_id, agent, cwd, started_at, status, context_report_json, route_reason, prompt, model, effort, attachments_json, purpose, visibility, owner_text, parent_run_id)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      runId, task.id, agent, workdir.cwd, startedAt, JSON.stringify(ctx.report), reason, opts.prompt, model ?? null, effort,
      attachments.length ? JSON.stringify(attachments) : null,
      purpose, visibility, purpose === 'user_reply' ? opts.ownerText ?? opts.prompt : null,
      task.handoff_json ? (JSON.parse(task.handoff_json) as { fromRun: string }).fromRun : null,
    );
    this.d.tasks.setStatus(task.id, 'running', { agent, route_reason: reason, not_before: null });
    this.d.bus.publish('run.started', this.getRun(runId));

    const sink = this.makeSink(task.id, runId, agent);
    const input: RunInput = {
      taskId: task.id,
      agent,
      runId,
      prompt: opts.prompt,
      contextPrefix: opts.resumeSessionId ? '' : task.mode === 'chat' ? `${ctx.prefix}${CHAT_GUIDE}` : ctx.prefix,
      cwd: workdir.cwd,
      resumeSessionId: opts.resumeSessionId,
      sandbox: task.type === 'admin' || task.type === 'update' ? 'read-only' : 'workspace-write',
      allowNetwork: task.type !== 'code' || task.outward === 1,
      taskType: task.type,
      vaultPath: this.d.vaultPath,
      mcpServers: this.mcpProvider?.(runId, task.id),
      effort: cfg.agents[agent].effort[effort] || undefined,
      model,
      attachments,
      // In a conversation either agent may look things up on the web when the question needs it.
      ...(task.mode === 'chat' ? { webSearch: true } : {}),
    };
    for (const h of this.inputHooks) h(task, input);

    const handle = this.d.runners.get(agent).start(input, sink);
    this.active.set(task.id, { taskId: task.id, runId, handle, agent, visibility });
    void handle.done
      .then((result) => this.finish(task.id, runId, result, workdir))
      .catch((err) => this.finish(task.id, runId, { status: 'failed', summary: String(err), error: String(err), usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 }, toolCalls: 0 }, workdir));
    return runId;
  }

  /**
   * A tracked side run that leaves the task status alone. Parallel conversation answers start
   * immediately; consults and internal work require a free slot. Approvals are refused.
   */
  async sideRun(
    taskId: string,
    opts: { agent: AgentId; prompt: string; resumeSessionId: string | null; cwd: string; label: string; purpose: RunPurpose; parentRunId: string | null; model?: string; effort?: Effort; contextPrefix?: string; webSearch?: boolean; attachments?: Attachment[] },
  ): Promise<RunResult> {
    const task = this.d.tasks.get(taskId);
    if (!task) throw new Error('not_found');
    const cfg = this.d.config.get();
    if (this.stopped) throw new Error('Jarvis is shutting down');
    // Reject promptly instead of waiting for the slot the parent is holding.
    if (!['both', 'second_opinion'].includes(opts.purpose) && this.activeCount() >= cfg.maxConcurrentRuns) {
      return { status: 'failed', summary: 'Side run unavailable: all agent slots are busy. Continue on your own.', error: 'All agent slots are busy', usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 }, toolCalls: 0 };
    }
    const visibility: RunVisibility = opts.purpose === 'consult' ? 'activity' : ['learning', 'maintenance', 'verify'].includes(opts.purpose) ? 'internal' : 'conversation';
    const runId = newId('r');
    const model = opts.model && opts.model !== 'default' ? opts.model : cfg.agents[opts.agent].model || undefined;
    run(
      this.d.db,
      `INSERT INTO runs (id, task_id, agent, cwd, started_at, status, route_reason, prompt, model, effort, attachments_json, purpose, visibility, owner_text, parent_run_id) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      runId, taskId, opts.agent, opts.cwd, nowIso(), opts.label, opts.prompt, model ?? null, opts.effort ?? null, opts.attachments?.length ? JSON.stringify(opts.attachments) : null, opts.purpose, visibility, opts.parentRunId,
    );
    this.d.bus.publish('run.started', this.getRun(runId));
    const base = this.makeSink(taskId, runId, opts.agent, true);
    const handle = this.d.runners.get(opts.agent).start(
      {
        taskId, runId, prompt: opts.prompt, contextPrefix: opts.contextPrefix ?? '', cwd: opts.cwd, resumeSessionId: opts.resumeSessionId ?? undefined,
        sandbox: 'read-only', allowNetwork: !!opts.webSearch, webSearch: opts.webSearch, taskType: task.type, vaultPath: this.d.vaultPath,
        mcpServers: opts.contextPrefix ? this.mcpProvider?.(runId, taskId) : undefined,
        effort: opts.effort ? cfg.agents[opts.agent].effort[opts.effort] || undefined : undefined,
        model,
        attachments: opts.attachments,
      },
      base,
    );
    this.active.set(runId, { taskId, runId, agent: opts.agent, handle, visibility });
    const result: RunResult = await handle.done.catch((err): RunResult => ({ status: 'failed' as const, summary: String(err), error: String(err), usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 }, toolCalls: 0 }));
    this.active.delete(runId);
    if (this.d.db.isOpen) {
      run(
        this.d.db,
        `UPDATE runs SET status = ?, ended_at = ?, input_tokens = ?, output_tokens = ?, cached_tokens = ?, cost_estimate_usd = ?, error = ?, session_id = COALESCE(?, session_id), answer = ? WHERE id = ?`,
        result.status, nowIso(), result.usage.inputTokens, result.usage.outputTokens, result.usage.cachedTokens, result.usage.costUsd, result.error ?? null, result.sessionId ?? null,
        result.status === 'done' ? result.summary.slice(0, ANSWER_CAP) : null, runId,
      );
      this.d.bus.publish('run.finished', this.getRun(runId));
    }
    this.tick();
    return result;
  }

  /** Store a normalized event on a run and publish it live (also used by modules, e.g. consults). */
  recordEvent(taskId: string, runId: string, e: NormalizedEvent): void {
    if (!this.d.db.isOpen) return;
    const withActivity = e.kind === 'tool_call' && !e.payload.activity
      ? { ...e.payload, activity: activityLine(String(e.payload.tool ?? ''), (e.payload.input ?? {}) as Record<string, unknown>) }
      : e.payload;
    const payload = capPayload(withActivity);
    const ts = nowIso();
    const r = run(this.d.db, 'INSERT INTO run_events (run_id, ts, kind, payload_json) VALUES (?, ?, ?, ?)', runId, ts, e.kind, JSON.stringify(payload));
    const stored: StoredRunEvent = { id: r.lastInsertRowid, run_id: runId, ts, kind: e.kind, payload_json: JSON.stringify(payload) };
    if (e.kind === 'tool_call') run(this.d.db, 'UPDATE runs SET tool_calls = tool_calls + 1 WHERE id = ?', runId);
    this.d.bus.publish('run.event', { taskId, ...stored, payload, visibility: this.getRun(runId)?.visibility });
  }

  private makeSink(taskId: string, runId: string, agent: AgentId, side = false): RunEventSink {
    let pendingApprovals = 0;
    return {
      emit: (e: NormalizedEvent) => this.recordEvent(taskId, runId, e),
      setSessionId: (id: string) => {
        run(this.d.db, 'UPDATE runs SET session_id = ? WHERE id = ?', id, runId);
      },
      requestApproval: async (req) => {
        if (side) return { approved: false, status: 'rejected', note: 'Approvals are not allowed during a read-only side run' };
        const { approval, decision } = this.d.approvals.request({ runId, taskId, ...req, detail: { ...req.detail, agent, runId } });
        pendingApprovals++;
        const t = this.d.tasks.get(taskId);
        if (t?.status === 'running') this.d.tasks.setStatus(taskId, 'needs_you');
        this.d.bus.publish('run.event', { taskId, run_id: runId, visibility: this.getRun(runId)?.visibility, kind: 'status', payload: { status: 'waiting_approval', approvalId: approval.id, summary: req.summary } });
        const d = await decision;
        pendingApprovals--;
        const cur = this.d.tasks.get(taskId);
        if (pendingApprovals === 0 && cur?.status === 'needs_you' && this.active.has(taskId)) this.d.tasks.setStatus(taskId, 'running');
        return d;
      },
      rateLimit: (reading) => this.d.usage.recordReading(reading),
      live: (delta) => this.d.bus.publish('run.delta', { taskId, runId, ...delta, visibility: this.getRun(runId)?.visibility }),
    };
  }

  private async finish(taskId: string, runId: string, result: RunResult, workdir: Workdir): Promise<void> {
    this.active.delete(taskId);
    if (!this.d.db.isOpen) return;
    run(
      this.d.db,
      `UPDATE runs SET status = ?, ended_at = ?, input_tokens = ?, output_tokens = ?, cached_tokens = ?, cost_estimate_usd = ?,
       tool_calls = MAX(tool_calls, ?), error = ?, session_id = COALESCE(?, session_id), answer = ? WHERE id = ?`,
      result.status, nowIso(), result.usage.inputTokens, result.usage.outputTokens, result.usage.cachedTokens, result.usage.costUsd,
      result.toolCalls, result.error ?? null, result.sessionId ?? null, result.status === 'done' ? result.summary.slice(0, ANSWER_CAP) : null, runId,
    );
    const t = this.d.tasks.get(taskId);
    if (t) {
      const summary = result.summary.length > 2000 ? `${result.summary.slice(0, 1997)}…` : result.summary;
      const status = result.status === 'done' ? 'done' : result.status === 'cancelled' ? 'cancelled' : 'failed';
      const expired = all<Approval>(this.d.db, "SELECT * FROM approvals WHERE run_id = ? AND status = 'expired' AND decided_via = 'expiry'", runId);
      const pending = all<Approval>(this.d.db, "SELECT * FROM approvals WHERE run_id = ? AND status = 'pending'", runId);
      if (pending.length && status === 'done') {
        this.d.tasks.setStatus(taskId, 'needs_you', { result_summary: `Waiting for your approval: ${pending[0].summary}. ${summary}` });
      } else if (expired.length && status !== 'cancelled') {
        this.d.tasks.setStatus(taskId, 'needs_you', { result_summary: `An approval expired without a decision. ${summary}` });
      } else {
        this.d.tasks.setStatus(taskId, status, { result_summary: summary });
      }
    }
    const finished = this.getRun(runId)!;
    this.d.bus.publish('run.finished', finished);
    if (result.status === 'failed' && LIMIT_ERROR.test(`${result.error ?? ''} ${result.summary}`)) await this.switchOnLimit(taskId, finished, workdir);
    const task = this.d.tasks.get(taskId);
    if (task && finished.visibility !== 'internal') {
      for (const h of this.afterRun) {
        try {
          await h({ task, run: finished, result, workdir });
        } catch (err) {
          log.warn(`afterRun hook failed for ${runId}`, err);
        }
      }
    }
    this.tick();
  }

  /** Context prefix for a side run that answers inside a conversation (same instructions as a main run). */
  async chatPrefix(task: Task): Promise<string> {
    const project = task.project_id ? get<Project>(this.d.db, 'SELECT * FROM projects WHERE id = ?', task.project_id) : undefined;
    const ctx = await this.context.build(task, project);
    return `${ctx.prefix}${CHAT_GUIDE}`;
  }

  /**
   * The agent ran out of plan mid-task: mark it limited (the router then avoids it until the reset)
   * and continue the same task on the other agent, in the same folder, with what was done so far.
   * One handover per run chain, never back and forth; if both are limited the task waits.
   */
  private async switchOnLimit(taskId: string, failed: Run, workdir: Workdir): Promise<void> {
    const from = failed.agent === 'codex' ? 'codex' : failed.agent === 'claude' ? 'claude' : null;
    if (!from || failed.purpose && failed.purpose !== 'user_reply' && failed.purpose !== 'handoff') return;
    const resetAt = new Date(Date.now() + 60 * 60_000).toISOString();
    this.d.usage.recordReading({ agent: from, window: 'five_hour', usedPercent: 100, resetsAt: resetAt, source: 'limit-hit' });
    const to: AgentId = from === 'claude' ? 'codex' : 'claude';
    const task = this.d.tasks.get(taskId);
    if (!task || this.d.config.get().router.switchOnLimit === false) return;
    if ((failed.route_reason ?? '').startsWith('limit handover')) {
      this.d.tasks.setStatus(taskId, 'failed', { result_summary: 'Both Claude and Codex have reached their plan limits. Send it again after a reset (see Agents for the times).' });
      return;
    }
    const other = this.d.usage.current()[to];
    const threshold = this.d.config.get().router.fallbackAtPercent;
    if ([other.five_hour, other.weekly].some((w) => w && w.usedPercent >= threshold)) {
      this.d.tasks.setStatus(taskId, 'failed', { result_summary: `${from === 'claude' ? 'Claude' : 'Codex'} reached its plan limit, and ${to === 'claude' ? 'Claude' : 'Codex'} is near its limit too. Send it again after a reset.` });
      return;
    }
    const files = all<{ payload_json: string }>(this.d.db, "SELECT payload_json FROM run_events WHERE run_id = ? AND kind = 'file_change'", failed.id)
      .map((e) => String((JSON.parse(e.payload_json) as { path?: string }).path ?? '')).filter(Boolean);
    const progress = get<{ payload_json: string }>(this.d.db, "SELECT payload_json FROM run_events WHERE run_id = ? AND kind = 'message' ORDER BY id DESC LIMIT 1", failed.id);
    const lastNote = progress ? String((JSON.parse(progress.payload_json) as { text?: string }).text ?? '').slice(0, 1500) : '';
    const asked = failed.owner_text ?? failed.prompt ?? task.title;
    const name = from === 'claude' ? 'Claude' : 'Codex';
    const note = [
      `${name} reached its plan limit part-way through this request, so you are taking over. Continue from where it stopped; do not start over.`,
      files.length ? `It already changed these files in the working folder: ${[...new Set(files)].slice(0, 30).join(', ')}.` : '',
      lastNote ? `Its last progress note:\n${lastNote}` : '',
      `The request:\n${asked}`,
    ].filter(Boolean).join('\n\n');
    const reason = `limit handover: ${from} → ${to}`;
    log.info(`${taskId}: ${from} hit its plan limit; continuing on ${to}`);
    this.d.bus.publish('notify', { message: `${name} reached its plan limit; ${to === 'claude' ? 'Claude' : 'Codex'} is continuing the task.`, level: 'info', taskId, taskTitle: task.title });
    if (task.mode === 'chat') {
      await this.ask(taskId, note, { agent: to }).catch((err) => log.warn('limit handover failed', err));
      const r = this.lastRun(taskId);
      if (r) run(this.d.db, 'UPDATE runs SET route_reason = ?, owner_text = ? WHERE id = ?', reason, failed.owner_text ?? null, r.id);
      return;
    }
    this.d.tasks.setStatus(taskId, 'queued', { not_before: null });
    this.starting.add(taskId);
    try {
      this.workdirHooks.unshift((t) => (t.id === taskId ? workdir : null));
      await this.startRun(this.d.tasks.get(taskId)!, { prompt: note, agent: to, forceAgent: true, reason });
    } finally {
      this.workdirHooks.shift();
      this.starting.delete(taskId);
    }
  }

  getRun(id: string): Run | undefined {
    return get<Run>(this.d.db, 'SELECT * FROM runs WHERE id = ?', id);
  }

  runsForTask(taskId: string): Run[] {
    return all<Run>(this.d.db, 'SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC', taskId);
  }

  events(runId: string, afterId = 0, limit = 500): StoredRunEvent[] {
    return all<StoredRunEvent>(this.d.db, 'SELECT * FROM run_events WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?', runId, afterId, Math.min(limit, 2000));
  }
}
