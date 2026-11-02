import type { Db } from '../db/index.ts';
import { all, get, run } from '../db/index.ts';
import type { EventBus } from '../events.ts';
import type { Approval } from '../types.ts';
import { newId, nowIso } from '../util/ids.ts';
import type { ApprovalDecision, ApprovalRequest } from '../runners/types.ts';

export type Decision = 'approved' | 'rejected';

interface Waiter {
  resolve: (d: ApprovalDecision) => void;
}

/**
 * Approvals queue. A live run awaiting a decision registers a waiter; approvals created without
 * a waiter (e.g. from a Codex MCP call or after a restart) are handled by `onOrphanDecision`.
 */
export class ApprovalService {
  private db: Db;
  private bus: EventBus;
  private waiters = new Map<string, Waiter>();
  /** Called when an approval with no live waiter is decided (orchestrator resumes the task). */
  onOrphanDecision: ((approval: Approval, decision: Decision, note: string | null) => void) | null = null;
  /** Handlers for approvals that gate a Jarvis action (detail.action), e.g. opening a PR. */
  readonly actions = new Map<string, (approval: Approval, decision: Decision, note: string | null) => void | Promise<void>>();

  constructor(db: Db, bus: EventBus) {
    this.db = db;
    this.bus = bus;
  }

  create(input: { runId: string | null; taskId: string | null } & ApprovalRequest): Approval {
    const a: Approval = {
      id: newId('a'),
      run_id: input.runId,
      task_id: input.taskId,
      kind: input.kind,
      summary: input.summary,
      detail_json: JSON.stringify({ ...input.detail, reason: input.reason ?? input.detail.reason ?? null }),
      status: 'pending',
      created_at: nowIso(),
      decided_at: null,
      decided_via: null,
      note: null,
    };
    run(
      this.db,
      'INSERT INTO approvals (id, run_id, task_id, kind, summary, detail_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      a.id, a.run_id, a.task_id, a.kind, a.summary, a.detail_json, a.status, a.created_at,
    );
    this.bus.publish('approval.created', a);
    return a;
  }

  /** Create an approval and wait for the owner. */
  request(input: { runId: string | null; taskId: string | null } & ApprovalRequest): { approval: Approval; decision: Promise<ApprovalDecision> } {
    const approval = this.create(input);
    const decision = new Promise<ApprovalDecision>((resolve) => this.waiters.set(approval.id, { resolve }));
    return { approval, decision };
  }

  /** Stop waiting live; a later decision then goes through `onOrphanDecision` (session resume). */
  detach(id: string): void {
    this.waiters.delete(id);
  }

  hasWaiter(id: string): boolean {
    return this.waiters.has(id);
  }

  get(id: string): Approval | undefined {
    return get<Approval>(this.db, 'SELECT * FROM approvals WHERE id = ?', id);
  }

  list(status?: string, limit = 200): Approval[] {
    if (status) return all<Approval>(this.db, 'SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT ?', status, limit);
    return all<Approval>(this.db, 'SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?', limit);
  }

  pendingCount(): number {
    return get<{ n: number }>(this.db, "SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'")?.n ?? 0;
  }

  pendingForRun(runId: string): Approval[] {
    return all<Approval>(this.db, "SELECT * FROM approvals WHERE run_id = ? AND status = 'pending'", runId);
  }

  decide(id: string, decision: Decision, note: string | null, via: string): Approval | { error: string } {
    const a = this.get(id);
    if (!a) return { error: 'not_found' };
    if (a.status !== 'pending') return { error: `already ${a.status}` };
    const decided_at = nowIso();
    run(this.db, 'UPDATE approvals SET status = ?, decided_at = ?, decided_via = ?, note = ? WHERE id = ?', decision, decided_at, via, note, id);
    const updated = { ...a, status: decision, decided_at, decided_via: via, note } as Approval;
    this.bus.publish('approval.updated', updated);
    const waiter = this.waiters.get(id);
    if (waiter) {
      this.waiters.delete(id);
      waiter.resolve({ approved: decision === 'approved', note: note ?? undefined, status: decision });
    } else {
      let action: string | undefined;
      try {
        action = (JSON.parse(updated.detail_json) as { action?: string }).action;
      } catch {
        action = undefined;
      }
      const handler = action ? this.actions.get(action) : undefined;
      if (handler) void Promise.resolve(handler(updated, decision, note)).catch(() => undefined);
      else this.onOrphanDecision?.(updated, decision, note);
    }
    return updated;
  }

  /** Expire approvals older than `hours`; waiting runs receive a rejection. */
  expireOld(hours: number, now = Date.now()): Approval[] {
    const cutoff = new Date(now - hours * 3600_000).toISOString();
    const stale = all<Approval>(this.db, "SELECT * FROM approvals WHERE status = 'pending' AND created_at < ?", cutoff);
    for (const a of stale) {
      run(this.db, "UPDATE approvals SET status = 'expired', decided_at = ?, decided_via = 'expiry' WHERE id = ?", nowIso(), a.id);
      const updated = { ...a, status: 'expired' as const, decided_via: 'expiry' };
      this.bus.publish('approval.updated', updated);
      const waiter = this.waiters.get(a.id);
      if (waiter) {
        this.waiters.delete(a.id);
        waiter.resolve({ approved: false, note: `No decision within ${hours} h`, status: 'expired' });
      }
    }
    return stale;
  }

  /** Resolve all waiters for a run as rejected (used on cancel). */
  abandonRun(runId: string, reason: string): void {
    for (const a of this.pendingForRun(runId)) {
      run(this.db, "UPDATE approvals SET status = 'expired', decided_at = ?, decided_via = 'cancel', note = ? WHERE id = ?", nowIso(), reason, a.id);
      this.bus.publish('approval.updated', { ...a, status: 'expired', decided_via: 'cancel', note: reason });
      const waiter = this.waiters.get(a.id);
      if (waiter) {
        this.waiters.delete(a.id);
        waiter.resolve({ approved: false, note: reason, status: 'expired' });
      }
    }
  }
}
