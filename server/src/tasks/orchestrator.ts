import type { ApprovalService } from '../approvals/service.ts';
import type { ConfigStore } from '../config.ts';
import type { Db } from '../db/index.ts';
import { all, get, run } from '../db/index.ts';
import type { EventBus } from '../events.ts';
import { decide } from '../router/index.ts';
import type { RunnerRegistry } from '../runners/index.ts';
import type { McpServerSpec, NormalizedEvent, RunEventSink, RunHandle, RunInput, RunResult } from '../runners/types.ts';
import type { AgentId, Approval, Project, Run, StoredRunEvent, Task } from '../types.ts';
import type { UsageMeter } from '../usage/meter.ts';
import { newId, nowIso } from '../util/ids.ts';
import { logger } from '../util/log.ts';
import { capPayload } from '../util/truncate.ts';
import type { ContextProvider } from './context.ts';
import type { TaskService } from './service.ts';
import { prepareWorkdir } from './workdir.ts';
import type { Workdir } from './workdir.ts';

const log = logger('orchestrator');

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
    return this.active.size + this.starting.size;
  }

  isActive(taskId: string): boolean {
    return this.active.has(taskId) || this.starting.has(taskId);
  }

  activeRuns(): Array<{ taskId: string; runId: string; agent: AgentId }> {
    return [...this.active.values()].map(({ taskId, runId, agent }) => ({ taskId, runId, agent }));
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
      const next = this.d.tasks.nextQueued([...this.active.keys(), ...this.starting]);
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
    const a = this.active.get(taskId);
    if (a) {
      await a.handle.cancel();
      this.d.approvals.abandonRun(a.runId, 'Run cancelled');
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
  async followUp(taskId: string, text: string): Promise<{ mode: 'live' | 'resumed' | 'queued'; runId?: string }> {
    const a = this.active.get(taskId);
    if (a?.handle.sendFollowUp) {
      await a.handle.sendFollowUp(text);
      return { mode: 'live', runId: a.runId };
    }
    if (a) throw new Error('this run cannot take follow-ups while active; wait for it to finish or stop it');
    const t = this.d.tasks.get(taskId);
    if (!t) throw new Error('not_found');
    const last = get<Run>(this.d.db, 'SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1', taskId);
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
        resumeSessionId: last?.session_id ?? undefined,
        agent: (last?.agent as AgentId) ?? undefined,
      });
      return { mode: 'resumed', runId: runId ?? undefined };
    } finally {
      this.starting.delete(taskId);
    }
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

  private async startRun(task: Task, opts: { prompt: string; resumeSessionId?: string; agent?: AgentId }): Promise<string | null> {
    const cfg = this.d.config.get();
    let agent: AgentId;
    let reason: string;
    if (opts.agent && opts.resumeSessionId) {
      agent = opts.agent;
      reason = `follow-up resumes ${agent} session`;
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
      workdir = await prepareWorkdir(task, project, this.d.dataDir);
      ctx = await this.context.build(task, project);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.d.tasks.setStatus(task.id, 'running', { agent, route_reason: reason });
      this.d.tasks.setStatus(task.id, 'failed', { result_summary: `Could not prepare the run: ${message}` });
      return null;
    }

    const runId = newId('r');
    const startedAt = nowIso();
    run(
      this.d.db,
      `INSERT INTO runs (id, task_id, agent, cwd, started_at, status, context_report_json, route_reason, prompt)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
      runId, task.id, agent, workdir.cwd, startedAt, JSON.stringify(ctx.report), reason, opts.prompt,
    );
    this.d.tasks.setStatus(task.id, 'running', { agent, route_reason: reason, not_before: null });
    this.d.bus.publish('run.started', this.getRun(runId));

    const sink = this.makeSink(task.id, runId, agent);
    const input: RunInput = {
      taskId: task.id,
      runId,
      prompt: opts.prompt,
      contextPrefix: opts.resumeSessionId ? '' : ctx.prefix,
      cwd: workdir.cwd,
      resumeSessionId: opts.resumeSessionId,
      sandbox: task.type === 'research' || task.type === 'admin' || task.type === 'update' ? 'read-only' : 'workspace-write',
      allowNetwork: task.type !== 'code' || task.outward === 1,
      taskType: task.type,
      vaultPath: this.d.vaultPath,
      mcpServers: this.mcpProvider?.(runId, task.id),
    };
    for (const h of this.inputHooks) h(task, input);

    const handle = this.d.runners.get(agent).start(input, sink);
    this.active.set(task.id, { taskId: task.id, runId, handle, agent });
    void handle.done
      .then((result) => this.finish(task.id, runId, result, workdir))
      .catch((err) => this.finish(task.id, runId, { status: 'failed', summary: String(err), error: String(err), usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 }, toolCalls: 0 }, workdir));
    return runId;
  }

  /**
   * A small follow-on run in an existing session that does not change the task's status (used by
   * the learning loop). Recorded as a run so its plan usage is visible. Approvals are refused.
   */
  async sideRun(taskId: string, opts: { agent: AgentId; prompt: string; resumeSessionId: string | null; cwd: string; label: string }): Promise<RunResult> {
    const task = this.d.tasks.get(taskId);
    if (!task) throw new Error('not_found');
    const runId = newId('r');
    run(
      this.d.db,
      `INSERT INTO runs (id, task_id, agent, cwd, started_at, status, route_reason, prompt) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
      runId, taskId, opts.agent, opts.cwd, nowIso(), opts.label, opts.prompt,
    );
    const base = this.makeSink(taskId, runId, opts.agent, true);
    const handle = this.d.runners.get(opts.agent).start(
      {
        taskId, runId, prompt: opts.prompt, contextPrefix: '', cwd: opts.cwd, resumeSessionId: opts.resumeSessionId ?? undefined,
        sandbox: 'read-only', allowNetwork: false, taskType: task.type, vaultPath: this.d.vaultPath,
      },
      base,
    );
    const result: RunResult = await handle.done.catch((err): RunResult => ({ status: 'failed' as const, summary: String(err), error: String(err), usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 }, toolCalls: 0 }));
    if (this.d.db.isOpen) {
      run(
        this.d.db,
        `UPDATE runs SET status = ?, ended_at = ?, input_tokens = ?, output_tokens = ?, cached_tokens = ?, cost_estimate_usd = ?, error = ?, session_id = COALESCE(?, session_id) WHERE id = ?`,
        result.status, nowIso(), result.usage.inputTokens, result.usage.outputTokens, result.usage.cachedTokens, result.usage.costUsd, result.error ?? null, result.sessionId ?? null, runId,
      );
      this.d.bus.publish('run.finished', this.getRun(runId));
    }
    return result;
  }

  private makeSink(taskId: string, runId: string, agent: AgentId, side = false): RunEventSink {
    const insert = this.d.db.prepare('INSERT INTO run_events (run_id, ts, kind, payload_json) VALUES (?, ?, ?, ?)');
    let pendingApprovals = 0;
    return {
      emit: (e: NormalizedEvent) => {
        const payload = capPayload(e.payload);
        const ts = nowIso();
        const r = insert.run(runId, ts, e.kind, JSON.stringify(payload));
        const stored: StoredRunEvent = { id: Number(r.lastInsertRowid), run_id: runId, ts, kind: e.kind, payload_json: JSON.stringify(payload) };
        if (e.kind === 'tool_call') run(this.d.db, 'UPDATE runs SET tool_calls = tool_calls + 1 WHERE id = ?', runId);
        this.d.bus.publish('run.event', { taskId, ...stored, payload });
      },
      setSessionId: (id: string) => {
        run(this.d.db, 'UPDATE runs SET session_id = ? WHERE id = ?', id, runId);
      },
      requestApproval: async (req) => {
        if (side) return { approved: false, status: 'rejected', note: 'Not allowed during a learning step' };
        const { approval, decision } = this.d.approvals.request({ runId, taskId, ...req, detail: { ...req.detail, agent, runId } });
        pendingApprovals++;
        const t = this.d.tasks.get(taskId);
        if (t?.status === 'running') this.d.tasks.setStatus(taskId, 'needs_you');
        this.d.bus.publish('run.event', { taskId, run_id: runId, kind: 'status', payload: { status: 'waiting_approval', approvalId: approval.id, summary: req.summary } });
        const d = await decision;
        pendingApprovals--;
        const cur = this.d.tasks.get(taskId);
        if (pendingApprovals === 0 && cur?.status === 'needs_you' && this.active.has(taskId)) this.d.tasks.setStatus(taskId, 'running');
        return d;
      },
      rateLimit: (reading) => this.d.usage.recordReading(reading),
    };
  }

  private async finish(taskId: string, runId: string, result: RunResult, workdir: Workdir): Promise<void> {
    this.active.delete(taskId);
    if (!this.d.db.isOpen) return;
    run(
      this.d.db,
      `UPDATE runs SET status = ?, ended_at = ?, input_tokens = ?, output_tokens = ?, cached_tokens = ?, cost_estimate_usd = ?,
       tool_calls = MAX(tool_calls, ?), error = ?, session_id = COALESCE(?, session_id) WHERE id = ?`,
      result.status, nowIso(), result.usage.inputTokens, result.usage.outputTokens, result.usage.cachedTokens, result.usage.costUsd,
      result.toolCalls, result.error ?? null, result.sessionId ?? null, runId,
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
    const task = this.d.tasks.get(taskId);
    if (task) {
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
