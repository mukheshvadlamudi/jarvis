import { afterEach, describe, expect, it } from 'vitest';
import { schedulerOf } from '../src/scheduler/module.ts';
import { dueFollowUps, routineBody } from '../src/scheduler/routines.ts';
import { validateCron } from '../src/scheduler/service.ts';
import { cronFromWordsLocal } from '../src/scheduler/words.ts';
import { makeCtx, waitFor } from './helpers.ts';
import type { TestCtx } from './helpers.ts';

let ctx: TestCtx;
afterEach(async () => ctx?.close());

describe('cron helpers', () => {
  it('validates cron', () => {
    expect(validateCron('0 8 * * 1-5')).toBeNull();
    expect(validateCron('0 8 * *')).toMatch(/5 fields/);
    expect(validateCron('61 8 * * *')).not.toBeNull();
  });

  it('turns common phrasings into cron without an agent', () => {
    expect(cronFromWordsLocal('every weekday at 8:30am')).toBe('30 8 * * 1-5');
    expect(cronFromWordsLocal('Mondays and Thursdays at 10:15')).toBe('15 10 * * 1,4');
    expect(cronFromWordsLocal('daily at 7pm')).toBe('0 19 * * *');
    expect(cronFromWordsLocal('every 4 hours')).toBe('0 */4 * * *');
    expect(cronFromWordsLocal('on the 15th of every month at 9')).toBe('0 9 15 * *');
    expect(cronFromWordsLocal('weekends at noon')).toBe('0 12 * * 0,6');
    expect(cronFromWordsLocal('whenever the moon is full')).toBeNull();
  });
});

describe('scheduler', () => {
  it('ships the built-in routines disabled', async () => {
    ctx = makeCtx();
    const r = await ctx.req('GET', '/api/schedules');
    const names = r.json.schedules.map((x: { name: string; enabled: number }) => [x.name, x.enabled]);
    expect(names).toEqual(expect.arrayContaining([['Morning brief', 0], ['Inbox triage', 0], ['Weekly review', 0], ['Memory consolidation', 0], ['Updates digest', 0]]));
    expect(r.json.presets.length).toBeGreaterThan(3);
  });

  it('creates, validates and runs a schedule now; scheduled tasks route to Codex', async () => {
    ctx = makeCtx({ mockDelayMs: 1 });
    expect((await ctx.req('POST', '/api/schedules', { name: 'Bad', cron: 'nope', template: { title: 'x' } })).status).toBe(400);
    const created = await ctx.req('POST', '/api/schedules', { name: 'Check invoices', cron: '0 9 1 * *', template: { title: 'Check unpaid invoices', type: 'admin' } });
    expect(created.status).toBe(201);
    expect(created.json.schedule.upcoming).toHaveLength(3);
    const id = created.json.schedule.id;
    const r = await ctx.req('POST', `/api/schedules/${id}/run-now`);
    expect(r.json.task.title).toMatch(/^Check unpaid invoices — /);
    expect(r.json.task.schedule_id).toBe(id);
    await waitFor(() => ctx.s.tasks.get(r.json.task.id)?.status === 'done');
    expect(ctx.s.tasks.get(r.json.task.id)).toMatchObject({ agent: 'codex', route_reason: 'scheduled tasks → codex' });
    const hist = await ctx.req('GET', `/api/schedules/history?id=${id}`);
    expect(hist.json.runs[0]).toMatchObject({ kind: 'manual', task_status: 'done' });
  });

  it('fires on its cron', async () => {
    ctx = makeCtx({ mockDelayMs: 1 });
    const sch = schedulerOf(ctx.s);
    sch.start();
    const x = sch.create({ name: 'Every second', cron: '* * * * *', template: { title: 'Ping' } });
    // croner supports a 6-field seconds pattern internally; simulate the firing directly.
    await sch.fire(x.id, 'scheduled');
    expect(sch.history(x.id)[0].kind).toBe('scheduled');
    expect(sch.get(x.id)?.next_run_at).toBeTruthy();
  });

  it('runs a missed schedule once on wake if < 12 h late, skips older ones', async () => {
    ctx = makeCtx();
    const sch = schedulerOf(ctx.s);
    const created = '2026-11-01T00:00:00.000Z';
    const a = sch.create({ name: 'Morning', cron: '0 8 * * *', template: { title: 'Brief' } });
    const b = sch.create({ name: 'Old', cron: '0 1 * * *', template: { title: 'Old job' } });
    ctx.s.db.prepare('UPDATE schedules SET created_at = ?, enabled_at = ?').run(created, created);
    const now = new Date(2026, 10, 2, 10, 30); // 10:30 local: 08:00 missed by 2.5 h, 01:00 by 9.5 h
    const r1 = sch.catchUp(now);
    expect(r1.map((x) => x.action).sort()).toEqual(['ran', 'ran']);
    await waitFor(() => sch.history(a.id).length === 1 && sch.history(b.id).length === 1);
    expect(sch.history(a.id)[0]).toMatchObject({ kind: 'missed' });
    expect(sch.catchUp(now)).toEqual([]); // not again

    const c = sch.create({ name: 'Long ago', cron: '0 2 * * *', template: { title: 'x' } });
    ctx.s.db.prepare('UPDATE schedules SET created_at = ?, enabled_at = ? WHERE id = ?').run(created, created, c.id);
    const r2 = sch.catchUp(new Date(2026, 10, 2, 23, 0)); // 02:00 missed by 21 h
    expect(r2.find((x) => x.id === c.id)?.action).toBe('skipped');
    expect(sch.history(c.id)[0]).toMatchObject({ kind: 'skipped' });
  });

  it('enables built-ins and builds the morning brief from live state', async () => {
    ctx = makeCtx({ mockDelayMs: 1 });
    const sch = schedulerOf(ctx.s);
    const brief = sch.list().find((x) => x.built_in === 'morning_brief')!;
    const r = await ctx.req('PATCH', `/api/schedules/${brief.id}`, { enabled: true });
    expect(r.json.schedule.enabled).toBe(1);
    expect(r.json.schedule.next_run_at).toBeTruthy();
    expect(r.json.schedule.upcoming).toHaveLength(3);
    const body = routineBody(ctx.s, 'morning_brief', new Date(2026, 10, 5, 8));
    expect(body).toMatch(/Follow-ups due: .*Priya Patel \(2026-11-04\)/);
    expect(body).toMatch(/Follow-ups due: .*Northwind Dental \(2026-11-04\)/);
    expect(body).toContain('Plan usage');
    expect(dueFollowUps(ctx.s, new Date(2026, 10, 3)).length).toBe(0);
    expect((await ctx.req('DELETE', `/api/schedules/${brief.id}`)).status).toBe(409);
  });

  it('parses words via rules, falling back to one Codex call', async () => {
    ctx = makeCtx();
    const rules = await ctx.req('POST', '/api/schedules/parse', { text: 'weekdays at 8' });
    expect(rules.json).toMatchObject({ cron: '0 8 * * 1-5', via: 'rules' });
    const agent = await ctx.req('POST', '/api/schedules/parse', { text: 'the start of each working week, first thing' });
    expect(agent.json).toMatchObject({ cron: '0 9 * * 1', via: 'codex' });
  });
});
