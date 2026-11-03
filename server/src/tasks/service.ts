import type { Db, Param } from '../db/index.ts';
import { all, get, run, updateSql } from '../db/index.ts';
import type { EventBus } from '../events.ts';
import type { AgentPref, Effort, Project, Task, TaskMode, TaskStatus, TaskType } from '../types.ts';
import { TASK_STATUSES, TASK_TYPES } from '../types.ts';
import { newId, nowIso } from '../util/ids.ts';
import { classify } from './classifier.ts';
import type { Classification } from './classifier.ts';
import { canManuallyTransition, canTransition } from './stateMachine.ts';

export interface CreateTaskInput {
  title: string;
  body?: string;
  type?: TaskType;
  priority?: number;
  project_id?: string | null;
  agent_pref?: AgentPref;
  effort?: Effort;
  parent_id?: string | null;
  schedule_id?: string | null;
  due_at?: string | null;
  outward?: boolean;
  /** Queue immediately (default) or park in the inbox. */
  run?: boolean;
  /** Hand off to another agent when this task finishes. */
  then?: unknown;
  /** Set on tasks created by a handoff. */
  handoff?: unknown;
  /** 'chat' for a conversation on Ask; default 'task'. */
  mode?: TaskMode;
}

export interface TaskFilter {
  status?: string;
  type?: string;
  project?: string;
  agent?: string;
  q?: string;
  mode?: string;
  limit?: number;
}

const PATCHABLE = ['title', 'body', 'type', 'priority', 'project_id', 'agent_pref', 'effort', 'due_at', 'result_summary', 'output_path', 'outward', 'then_json'] as const;

export class TaskService {
  private db: Db;
  private bus: EventBus;

  constructor(db: Db, bus: EventBus) {
    this.db = db;
    this.bus = bus;
  }

  projects(): Project[] {
    return all<Project>(this.db, 'SELECT * FROM projects ORDER BY name');
  }

  preview(text: string): Classification {
    return classify(text, this.projects());
  }

  create(input: CreateTaskInput): Task {
    const title = input.title.trim();
    if (!title) throw new Error('title is required');
    const c = classify(`${title}\n${input.body ?? ''}`, this.projects());
    const now = nowIso();
    const t: Task = {
      id: newId('t'),
      title: title.slice(0, 300),
      body: input.body ?? '',
      type: input.type && TASK_TYPES.includes(input.type) ? input.type : c.type,
      status: input.run === false ? 'inbox' : 'queued',
      priority: input.priority ?? 0,
      project_id: input.project_id === undefined ? c.projectId : input.project_id,
      agent_pref: input.agent_pref ?? 'auto',
      agent: null,
      effort: input.effort ?? c.effort,
      parent_id: input.parent_id ?? null,
      schedule_id: input.schedule_id ?? null,
      created_at: now,
      updated_at: now,
      due_at: input.due_at ?? null,
      result_summary: null,
      output_path: null,
      outward: (input.outward ?? c.outward) ? 1 : 0,
      route_reason: null,
      not_before: null,
      then_json: input.then ? JSON.stringify(input.then) : null,
      handoff_json: input.handoff ? JSON.stringify(input.handoff) : null,
      mode: input.mode === 'chat' ? 'chat' : 'task',
    };
    run(
      this.db,
      `INSERT INTO tasks (id, title, body, type, status, priority, project_id, agent_pref, agent, effort, parent_id, schedule_id,
        created_at, updated_at, due_at, result_summary, output_path, outward, route_reason, not_before)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      t.id, t.title, t.body, t.type, t.status, t.priority, t.project_id, t.agent_pref, t.agent, t.effort, t.parent_id, t.schedule_id,
      t.created_at, t.updated_at, t.due_at, t.result_summary, t.output_path, t.outward, t.route_reason, t.not_before,
    );
    if (t.mode === 'chat') run(this.db, 'UPDATE tasks SET mode = ? WHERE id = ?', t.mode, t.id);
    if (t.then_json || t.handoff_json) run(this.db, 'UPDATE tasks SET then_json = ?, handoff_json = ? WHERE id = ?', t.then_json, t.handoff_json, t.id);
    this.bus.publish('task.created', t);
    return t;
  }

  get(id: string): Task | undefined {
    return get<Task>(this.db, 'SELECT * FROM tasks WHERE id = ?', id);
  }

  list(f: TaskFilter = {}): Task[] {
    const where: string[] = [];
    const params: Param[] = [];
    if (f.status) {
      const statuses = f.status.split(',').filter((s) => TASK_STATUSES.includes(s as TaskStatus));
      if (statuses.length) {
        where.push(`status IN (${statuses.map(() => '?').join(',')})`);
        params.push(...statuses);
      }
    }
    if (f.type) {
      where.push('type = ?');
      params.push(f.type);
    }
    if (f.project) {
      where.push('project_id = ?');
      params.push(f.project);
    }
    if (f.agent) {
      where.push('(agent = ? OR (agent IS NULL AND agent_pref = ?))');
      params.push(f.agent, f.agent);
    }
    if (f.mode === 'chat' || f.mode === 'task') {
      where.push('mode = ?');
      params.push(f.mode);
    }
    if (f.q) {
      // Conversations are searchable by what was asked and answered, not only the title.
      // Internal runs (learning, maintenance) never make a conversation match.
      where.push("(title LIKE ? OR body LIKE ? OR id IN (SELECT task_id FROM runs WHERE (visibility IS NULL OR visibility <> 'internal') AND (COALESCE(owner_text, prompt) LIKE ? OR answer LIKE ?)))");
      params.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`, `%${f.q}%`);
    }
    const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'needs_you' THEN 1 WHEN 'queued' THEN 2 WHEN 'inbox' THEN 3 ELSE 4 END,
      priority DESC, updated_at DESC LIMIT ?`;
    params.push(Math.min(f.limit ?? 300, 1000));
    return all<Task>(this.db, sql, ...params);
  }

  /** Owner-initiated field edits. Status changes go through `move`. */
  patch(id: string, patch: Partial<Record<(typeof PATCHABLE)[number], unknown>>): Task {
    const cur = this.get(id);
    if (!cur) throw new Error('not_found');
    const clean: Record<string, unknown> = { ...patch };
    if (clean.type !== undefined && !TASK_TYPES.includes(clean.type as TaskType)) throw new Error('invalid type');
    if (clean.agent_pref !== undefined && !['auto', 'claude', 'codex'].includes(clean.agent_pref as string)) throw new Error('invalid agent_pref');
    if (clean.effort !== undefined && !['low', 'medium', 'high'].includes(clean.effort as string)) throw new Error('invalid effort');
    if (typeof clean.outward === 'boolean') clean.outward = clean.outward ? 1 : 0;
    const { set, values } = updateSql(clean, PATCHABLE);
    if (!set) return cur;
    run(this.db, `UPDATE tasks SET ${set}, updated_at = ? WHERE id = ?`, ...values, nowIso(), id);
    const t = this.get(id)!;
    this.bus.publish('task.updated', t);
    return t;
  }

  /** Internal status transition (orchestrator). Throws on an illegal transition. */
  setStatus(id: string, status: TaskStatus, extra: Partial<Pick<Task, 'agent' | 'route_reason' | 'not_before' | 'result_summary' | 'output_path'>> = {}): Task {
    const cur = this.get(id);
    if (!cur) throw new Error('not_found');
    if (!canTransition(cur.status, status)) throw new Error(`illegal transition ${cur.status} → ${status}`);
    const { set, values } = updateSql({ status, ...extra }, ['status', 'agent', 'route_reason', 'not_before', 'result_summary', 'output_path']);
    run(this.db, `UPDATE tasks SET ${set}, updated_at = ? WHERE id = ?`, ...values, nowIso(), id);
    const t = this.get(id)!;
    this.bus.publish('task.updated', t);
    return t;
  }

  /** Owner-initiated status change, validated against the manual transition table. */
  move(id: string, status: TaskStatus): Task {
    const cur = this.get(id);
    if (!cur) throw new Error('not_found');
    if (!canManuallyTransition(cur.status, status)) throw new Error(`cannot move a ${cur.status} task to ${status}`);
    return this.setStatus(id, status, status === 'queued' ? { not_before: null } : {});
  }

  delete(id: string): boolean {
    const r = run(this.db, 'DELETE FROM tasks WHERE id = ?', id);
    if (r.changes) this.bus.publish('task.deleted', { id });
    return r.changes > 0;
  }

  /** Next queued task that is not held back (e.g. waiting for a usage reset). */
  nextQueued(excludeIds: string[], now = nowIso()): Task | undefined {
    const ex = excludeIds.length ? `AND id NOT IN (${excludeIds.map(() => '?').join(',')})` : '';
    return get<Task>(
      this.db,
      `SELECT * FROM tasks WHERE status = 'queued' AND (not_before IS NULL OR not_before <= ?) ${ex}
       ORDER BY priority DESC, created_at ASC LIMIT 1`,
      now,
      ...excludeIds,
    );
  }

  counts(): Record<TaskStatus, number> {
    const out = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
    for (const r of all<{ status: TaskStatus; n: number }>(this.db, 'SELECT status, COUNT(*) AS n FROM tasks GROUP BY status')) out[r.status] = r.n;
    return out;
  }
}
