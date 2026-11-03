import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseSkillReply } from '../src/skills/learning.ts';
import { skillsOf } from '../src/skills/module.ts';
import { syncSkills } from '../src/skills/sync.ts';
import { makeCtx, waitFor } from './helpers.ts';
import type { TestCtx } from './helpers.ts';

let ctx: TestCtx;
afterEach(async () => ctx?.close());

describe('skills registry + sync', () => {
  it('registers vault skills', async () => {
    ctx = makeCtx();
    const r = await ctx.req('GET', '/api/skills');
    expect(r.json.skills.map((s: { name: string }) => s.name)).toEqual(['browser', 'calendar', 'client-email', 'drive', 'gmail', 'release-notes']);
    expect(r.json.skills[0].sync).toEqual({ claude: 'add', codex: 'add' });
  });

  it('dry-run plans changes without writing; real sync copies and tracks a manifest', () => {
    ctx = makeCtx();
    const { registry } = skillsOf(ctx.s);
    const targets = ctx.s.env.skillsTargets;
    const plan = syncSkills(registry, ctx.s.db, targets, { dryRun: true });
    expect(plan.actions.filter((a) => a.action === 'add')).toHaveLength(12);
    expect(existsSync(targets.claude)).toBe(false);

    // A skill the owner installed by hand must never be touched.
    mkdirSync(join(targets.codex, 'gmail'), { recursive: true });
    writeFileSync(join(targets.codex, 'gmail', 'SKILL.md'), 'mine');
    const done = syncSkills(registry, ctx.s.db, targets);
    expect(done.actions).toContainEqual(expect.objectContaining({ target: 'codex', skill: 'gmail', action: 'skip' }));
    expect(readFileSync(join(targets.codex, 'gmail', 'SKILL.md'), 'utf8')).toBe('mine');
    expect(readFileSync(join(targets.claude, 'release-notes', 'SKILL.md'), 'utf8')).toContain('name: release-notes');
    expect(JSON.parse(readFileSync(join(targets.claude, '.jarvis-manifest.json'), 'utf8')).managed['release-notes']).toBeTruthy();

    registry.setEnabled('release-notes', false);
    const after = syncSkills(registry, ctx.s.db, targets);
    expect(after.actions).toContainEqual(expect.objectContaining({ target: 'claude', skill: 'release-notes', action: 'remove' }));
    expect(existsSync(join(targets.claude, 'release-notes'))).toBe(false);
    expect(syncSkills(registry, ctx.s.db, targets).actions.every((a) => a.action === 'unchanged' || a.action === 'skip')).toBe(true);
  });

  it('creates connector skills from templates', async () => {
    ctx = makeCtx();
    expect((await ctx.req('POST', '/api/skills/templates/gmail')).status).toBe(409);
    await ctx.req('PATCH', '/api/skills/gmail', { enabled: false });
    expect(skillsOf(ctx.s).registry.get('gmail')?.enabled).toBe(0);
  });
});

describe('learning loop', () => {
  it('parses agent replies', () => {
    expect(parseSkillReply('{"skill": null}')).toBeNull();
    expect(parseSkillReply('Sure! {"skill": {"name": "Deploy Staging", "description": "d", "body": "# x", "updates": null}}')).toMatchObject({ name: 'deploy-staging', updates: null });
    expect(parseSkillReply('not json')).toBeNull();
  });

  it('proposes a skill after a long run and writes it to the vault on approval', async () => {
    ctx = makeCtx({ mockDelayMs: 1 });
    ctx.s.config.update({ learning: { minToolCalls: 8 } });
    const id = (await ctx.req('POST', '/api/tasks', { title: 'Investigate the slow invoices page [mock:tools]', type: 'other' })).json.task.id;
    await waitFor(() => ctx.s.tasks.get(id)?.status === 'done');
    await skillsOf(ctx.s).learning.idle();
    const props = (await ctx.req('GET', '/api/skills/proposals?status=pending')).json.proposals;
    expect(props).toHaveLength(1);
    expect(props[0].name).toBe('flaky-test-triage');
    const runs = ctx.s.orchestrator.runsForTask(id);
    expect(runs[0].route_reason).toMatch(/learning loop/);
    expect(runs[0]).toMatchObject({ purpose: 'learning', visibility: 'internal', owner_text: null, parent_run_id: runs[1].id });
    expect(runs[0].session_id).not.toBe(runs[1].session_id);
    expect(ctx.s.tasks.get(id)?.status).toBe('done');

    const r = await ctx.req('POST', `/api/skills/proposals/${props[0].id}`, { decision: 'approved', description: 'Fix flaky tests properly.' });
    expect(r.json.proposal.status).toBe('approved');
    const file = join(ctx.s.env.vault, 'Skills/flaky-test-triage/SKILL.md');
    expect(readFileSync(file, 'utf8')).toContain('description: Fix flaky tests properly.');
    expect(existsSync(join(ctx.s.env.skillsTargets.claude, 'flaky-test-triage', 'SKILL.md'))).toBe(true);
  });

  it('skips short runs', async () => {
    ctx = makeCtx({ mockDelayMs: 1 });
    const id = (await ctx.req('POST', '/api/tasks', { title: 'Quick admin thing', type: 'admin' })).json.task.id;
    await waitFor(() => ctx.s.tasks.get(id)?.status === 'done');
    await skillsOf(ctx.s).learning.idle();
    expect(skillsOf(ctx.s).learning.list()).toHaveLength(0);
  });
});
