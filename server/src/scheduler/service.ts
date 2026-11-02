import { Cron } from 'croner';
import type { Services } from '../app.ts';
import { all, get, run } from '../db/index.ts';
import type { Task } from '../types.ts';
import { newId, nowIso } from '../util/ids.ts';
import { logger } from '../util/log.ts';
import { BUILT_INS, routineBody } from './routines.ts';
import type { TaskTemplate } from './routines.ts';

const log = logger('scheduler');
const MISSED_WINDOW_MS = 12 * 3600_000;

export interface Schedule {
  id: string;
  name: string;
  cron: string;
  task_template_json: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  built_in: string | null;
  description: string;
  created_at: string;
  enabled_at: string | null;
}

export interface ScheduleRun {
  id: number;
  schedule_id: string;
  ts: string;
  due_at: string | null;
  kind: 'scheduled' | 'manual' | 'missed' | 'skipped' | 'failed';
  task_id: string | null;
  note: string | null;
}

export const PRESETS: Array<{ label: string; cron: string }> = [
  { label: 'Weekdays at 08:00', cron: '0 8 * * 1-5' },
  { label: 'Every day at 07:30', cron: '30 7 * * *' },
  { label: 'Every Monday at 09:00', cron: '0 9 * * 1' },
  { label: 'Fridays at 16:00', cron: '0 16 * * 5' },
  { label: 'Sundays at 18:00', cron: '0 18 * * 0' },
  { label: 'Every 4 hours', cron: '0 */4 * * *' },
  { label: 'First of the month at 09:00', cron: '0 9 1 * *' },
];

export function validateCron(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return 'Use 5 fields: minute hour day-of-month month day-of-week';
  try {
    const c = new Cron(expr.trim(), { paused: true });
    if (!c.nextRun()) return 'This schedule never runs';
    c.stop();
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

export function nextRuns(expr: string, n = 3, from = new Date()): string[] {
  try {
    const c = new Cron(expr, { paused: true });
    const out = c.nextRuns(n, from).map((d) => d.toISOString());
    c.stop();
    return out;
  } catch {
    return [];
  }
}

function previousRun(expr: string, ref: Date): Date | null {
  try {
    const c = new Cron(expr, { paused: true });
    const p = c.previousRuns(1, ref)[0] ?? null;
    c.stop();
    return p;
  } catch {
    return null;
  }
}

/**
 * Cron schedules (croner, system timezone). Each firing creates a task from the schedule's template
 * (routed with `scheduled ⇒ router.scheduledTasks`). Missed runs while the laptop slept run once on
 * wake if missed by < 12 h; older ones are skipped and logged.
 */
export class Scheduler {
  private s: Services;
  private jobs = new Map<string, Cron>();
  private heartbeat: NodeJS.Timeout | null = null;
  private lastBeat = Date.now();

  constructor(s: Services) {
    this.s = s;
  }

  ensureBuiltIns(): void {
    for (const b of BUILT_INS) {
      const exists = get<{ id: string }>(this.s.db, 'SELECT id FROM schedules WHERE built_in = ?', b.key);
      if (exists) continue;
      run(
        this.s.db,
        `INSERT INTO schedules (id, name, cron, task_template_json, enabled, built_in, description, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
        newId('sc'), b.name, b.cron, JSON.stringify(b.template), b.key, b.description, nowIso(),
      );
    }
  }

  list(): Schedule[] {
    return all<Schedule>(this.s.db, 'SELECT * FROM schedules ORDER BY built_in IS NULL, name');
  }

  get(id: string): Schedule | undefined {
    return get<Schedule>(this.s.db, 'SELECT * FROM schedules WHERE id = ?', id);
  }

  history(id?: string, limit = 50): Array<ScheduleRun & { name: string; task_status: string | null; task_title: string | null }> {
    return all(
      this.s.db,
      `SELECT r.*, s.name, t.status AS task_status, t.title AS task_title FROM schedule_runs r JOIN schedules s ON s.id = r.schedule_id
       LEFT JOIN tasks t ON t.id = r.task_id ${id ? 'WHERE r.schedule_id = ?' : ''} ORDER BY r.ts DESC LIMIT ?`,
      ...(id ? [id, limit] : [limit]),
    );
  }

  /** (Re)arm cron jobs for all enabled schedules and catch up on missed runs. */
  start(): void {
    this.ensureBuiltIns();
    for (const sch of this.list()) this.arm(sch);
    this.catchUp();
    // Detect sleep/wake: if the heartbeat fires late, the machine was asleep → check missed runs.
    this.lastBeat = Date.now();
    this.heartbeat = setInterval(() => {
      const now = Date.now();
      if (now - this.lastBeat > 3 * 60_000) {
        log.info(`woke after ${Math.round((now - this.lastBeat) / 60_000)} min; checking missed runs`);
        for (const sch of this.list()) this.arm(sch);
        this.catchUp(new Date(now));
      }
      this.lastBeat = now;
    }, 60_000);
    this.heartbeat.unref();
  }

  stop(): void {
    for (const j of this.jobs.values()) j.stop();
    this.jobs.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private arm(sch: Schedule): void {
    this.jobs.get(sch.id)?.stop();
    this.jobs.delete(sch.id);
    if (!sch.enabled) {
      run(this.s.db, 'UPDATE schedules SET next_run_at = NULL WHERE id = ?', sch.id);
      return;
    }
    try {
      const job = new Cron(sch.cron, { unref: true, name: sch.id, protect: true }, () => {
        const due = new Date();
        void this.fire(sch.id, 'scheduled', due);
      });
      this.jobs.set(sch.id, job);
      run(this.s.db, 'UPDATE schedules SET next_run_at = ? WHERE id = ?', job.nextRun()?.toISOString() ?? null, sch.id);
    } catch (err) {
      log.warn(`schedule ${sch.name} has an invalid cron "${sch.cron}"`, err);
    }
  }

  /** Run once for schedules whose last due time passed while Jarvis was not running (< 12 h). */
  catchUp(now = new Date()): Array<{ id: string; action: 'ran' | 'skipped' }> {
    const out: Array<{ id: string; action: 'ran' | 'skipped' }> = [];
    for (const sch of this.list()) {
      if (!sch.enabled) continue;
      const prev = previousRun(sch.cron, now);
      if (!prev) continue;
      const since = Date.parse(sch.last_run_at ?? sch.enabled_at ?? sch.created_at);
      if (prev.getTime() <= since) continue;
      // Avoid double-firing a job croner is about to fire this very minute.
      if (now.getTime() - prev.getTime() < 60_000) continue;
      if (now.getTime() - prev.getTime() <= MISSED_WINDOW_MS) {
        void this.fire(sch.id, 'missed', prev);
        out.push({ id: sch.id, action: 'ran' });
      } else {
        run(this.s.db, 'INSERT INTO schedule_runs (schedule_id, ts, due_at, kind, note) VALUES (?, ?, ?, ?, ?)', sch.id, now.toISOString(), prev.toISOString(), 'skipped', `Missed by ${Math.round((now.getTime() - prev.getTime()) / 3600_000)} h (over 12 h) — skipped`);
        run(this.s.db, 'UPDATE schedules SET last_run_at = ? WHERE id = ?', now.toISOString(), sch.id);
        out.push({ id: sch.id, action: 'skipped' });
        this.s.bus.publish('schedule.ran', { id: sch.id, kind: 'skipped' });
      }
    }
    return out;
  }

  /** Create the task for one firing. Returns the task (or null if the schedule is gone). */
  async fire(id: string, kind: 'scheduled' | 'manual' | 'missed', due = new Date()): Promise<Task | null> {
    const sch = this.get(id);
    if (!sch) return null;
    const now = nowIso();
    try {
      const tpl = JSON.parse(sch.task_template_json) as TaskTemplate;
      const body = tpl.routine ? routineBody(this.s, tpl.routine, due) : tpl.body ?? '';
      const day = due.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      const t = this.s.tasks.create({
        title: `${tpl.title} — ${day}`,
        body,
        type: tpl.type,
        agent_pref: tpl.agent_pref ?? 'auto',
        project_id: tpl.project_id ?? null,
        schedule_id: sch.id,
        run: true,
      });
      run(this.s.db, 'INSERT INTO schedule_runs (schedule_id, ts, due_at, kind, task_id, note) VALUES (?, ?, ?, ?, ?, ?)', sch.id, now, due.toISOString(), kind, t.id, kind === 'missed' ? 'Ran on wake (missed while asleep)' : null);
      const next = this.jobs.get(sch.id)?.nextRun()?.toISOString() ?? (sch.enabled ? nextRuns(sch.cron, 1)[0] ?? null : null);
      run(this.s.db, 'UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?', now, next, sch.id);
      this.s.bus.publish('schedule.ran', { id: sch.id, kind, taskId: t.id });
      this.s.orchestrator.tick();
      return t;
    } catch (err) {
      run(this.s.db, 'INSERT INTO schedule_runs (schedule_id, ts, due_at, kind, note) VALUES (?, ?, ?, ?, ?)', sch.id, now, due.toISOString(), 'failed', (err as Error).message);
      this.s.bus.publish('schedule.ran', { id: sch.id, kind: 'failed' });
      log.warn(`schedule ${sch.name} failed to create its task`, err);
      return null;
    }
  }

  create(input: { name: string; cron: string; template: TaskTemplate; enabled?: boolean; description?: string }): Schedule {
    const err = validateCron(input.cron);
    if (err) throw new Error(`invalid cron: ${err}`);
    if (!input.name.trim()) throw new Error('name is required');
    if (!input.template?.title?.trim()) throw new Error('task title is required');
    const id = newId('sc');
    const now = nowIso();
    run(
      this.s.db,
      `INSERT INTO schedules (id, name, cron, task_template_json, enabled, description, created_at, enabled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id, input.name.trim(), input.cron.trim(), JSON.stringify(input.template), input.enabled === false ? 0 : 1, input.description ?? '', now, input.enabled === false ? null : now,
    );
    this.arm(this.get(id)!);
    this.s.bus.publish('schedule.updated', { id });
    return this.get(id)!;
  }

  update(id: string, patch: { name?: string; cron?: string; enabled?: boolean; template?: TaskTemplate; description?: string }): Schedule {
    const cur = this.get(id);
    if (!cur) throw new Error('not_found');
    if (patch.cron !== undefined) {
      const err = validateCron(patch.cron);
      if (err) throw new Error(`invalid cron: ${err}`);
    }
    const tpl = patch.template ? { ...JSON.parse(cur.task_template_json), ...patch.template } : JSON.parse(cur.task_template_json);
    const enabling = patch.enabled === true && !cur.enabled;
    run(
      this.s.db,
      'UPDATE schedules SET name = ?, cron = ?, enabled = ?, task_template_json = ?, description = ?, enabled_at = ? WHERE id = ?',
      patch.name?.trim() || cur.name, patch.cron?.trim() || cur.cron, patch.enabled === undefined ? cur.enabled : patch.enabled ? 1 : 0, JSON.stringify(tpl),
      patch.description ?? cur.description, enabling ? nowIso() : cur.enabled_at, id,
    );
    this.arm(this.get(id)!);
    this.s.bus.publish('schedule.updated', { id });
    return this.get(id)!;
  }

  delete(id: string): boolean {
    const cur = this.get(id);
    if (!cur) return false;
    if (cur.built_in) throw new Error('built-in routines can be disabled but not deleted');
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
    run(this.s.db, 'DELETE FROM schedules WHERE id = ?', id);
    this.s.bus.publish('schedule.updated', { id });
    return true;
  }
}
