import type { Db } from '../db/index.ts';
import { all, get, run } from '../db/index.ts';
import type { EventBus } from '../events.ts';
import type { Orchestrator, RunFinishedContext } from '../tasks/orchestrator.ts';
import type { AgentId } from '../types.ts';
import { newId, nowIso, slugify } from '../util/ids.ts';
import { logger } from '../util/log.ts';
import type { SkillRegistry } from './registry.ts';

const log = logger('learning');

export interface SkillProposal {
  id: string;
  run_id: string | null;
  name: string;
  description: string;
  body: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  decided_at: string | null;
  existing: number;
}

export function learnPrompt(existing: Array<{ name: string; description: string }>): string {
  return `[jarvis:learn] Jarvis learning step — do not use any tools.
Review the completed work supplied below. If it contains a reusable procedure the owner will want again, write it as a skill. Prefer updating an existing skill over creating a near-duplicate.
Existing skills:
${existing.map((s) => `- ${s.name}: ${s.description}`).join('\n') || '- (none)'}

Reply with ONLY one JSON object, no prose:
{"skill": null}
or
{"skill": {"name": "kebab-case-name", "description": "one line saying when to use it", "body": "# Title\\n\\nNumbered steps in markdown", "updates": "existing-skill-name or null"}}`;
}

/** Pull the first JSON object out of an agent reply. */
export function parseSkillReply(text: string): { name: string; description: string; body: string; updates: string | null } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as { skill?: { name?: unknown; description?: unknown; body?: unknown; updates?: unknown } | null };
    const s = obj.skill;
    if (!s || typeof s.name !== 'string' || typeof s.body !== 'string' || !s.name.trim() || !s.body.trim()) return null;
    return {
      name: slugify(s.name, 60),
      description: typeof s.description === 'string' ? s.description.trim().slice(0, 300) : '',
      body: s.body.slice(0, 20_000),
      updates: typeof s.updates === 'string' && s.updates.trim() ? slugify(s.updates, 60) : null,
    };
  } catch {
    return null;
  }
}

/**
 * SPEC §10 learning loop. Qualifying work gets an isolated skill-proposal run so internal prompts
 * never enter the owner's agent session. One learning step at a time.
 */
export class LearningLoop {
  private db: Db;
  private bus: EventBus;
  private registry: SkillRegistry;
  private orchestrator: Orchestrator;
  private cfg: () => { enabled: boolean; minToolCalls: number };
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: { db: Db; bus: EventBus; registry: SkillRegistry; orchestrator: Orchestrator; cfg: () => { enabled: boolean; minToolCalls: number } }) {
    this.db = opts.db;
    this.bus = opts.bus;
    this.registry = opts.registry;
    this.orchestrator = opts.orchestrator;
    this.cfg = opts.cfg;
  }

  qualifies(ctx: RunFinishedContext): boolean {
    const c = this.cfg();
    return c.enabled && ctx.result.status === 'done' && ctx.run.tool_calls >= c.minToolCalls && !!ctx.run.session_id && ctx.run.purpose !== 'learning' && ctx.run.visibility !== 'internal';
  }

  /** afterRun hook: queue a learning step for qualifying runs. */
  hook = (ctx: RunFinishedContext): void => {
    if (!this.qualifies(ctx)) return;
    this.chain = this.chain.then(() => this.learn(ctx).then(() => undefined)).catch((err) => log.warn('learning step failed', err));
  };

  async idle(): Promise<void> {
    await this.chain;
  }

  async learn(ctx: RunFinishedContext): Promise<SkillProposal | null> {
    const existing = this.registry.list().map((s) => ({ name: s.name, description: s.description }));
    const result = await this.orchestrator.sideRun(ctx.task.id, {
      purpose: 'learning', parentRunId: ctx.run.id,
      agent: ctx.run.agent as AgentId,
      prompt: `${learnPrompt(existing)}

Work just completed:
${ctx.result.summary}`,
      resumeSessionId: null,
      cwd: ctx.run.cwd,
      label: 'learning loop: skill proposal',
    });
    if (result.status !== 'done') return null;
    const parsed = parseSkillReply(result.summary);
    if (!parsed) return null;
    const name = parsed.updates && this.registry.get(parsed.updates) ? parsed.updates : parsed.name;
    const dupe = get<{ id: string }>(this.db, "SELECT id FROM skill_proposals WHERE name = ? AND status = 'pending'", name);
    if (dupe) return null;
    const p: SkillProposal = {
      id: newId('sp'),
      run_id: ctx.run.id,
      name,
      description: parsed.description,
      body: parsed.body,
      status: 'pending',
      created_at: nowIso(),
      decided_at: null,
      existing: this.registry.get(name) ? 1 : 0,
    };
    run(this.db, `INSERT INTO skill_proposals (id, run_id, name, description, body, status, created_at, existing) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`, p.id, p.run_id, p.name, p.description, p.body, p.created_at, p.existing);
    this.bus.publish('skills.updated', { proposal: p.id });
    return p;
  }

  list(status?: string): SkillProposal[] {
    if (status) return all<SkillProposal>(this.db, 'SELECT * FROM skill_proposals WHERE status = ? ORDER BY created_at DESC', status);
    return all<SkillProposal>(this.db, 'SELECT * FROM skill_proposals ORDER BY created_at DESC LIMIT 200');
  }

  /** Approve (optionally with owner edits) → write to the vault; or reject. */
  decide(id: string, decision: 'approved' | 'rejected', edits: { name?: string; description?: string; body?: string } = {}): SkillProposal {
    const p = get<SkillProposal>(this.db, 'SELECT * FROM skill_proposals WHERE id = ?', id);
    if (!p) throw new Error('not_found');
    if (p.status !== 'pending') throw new Error(`proposal is already ${p.status}`);
    if (decision === 'approved') {
      const name = edits.name?.trim() || p.name;
      this.registry.write(name, edits.description ?? p.description, edits.body ?? p.body);
    }
    run(this.db, 'UPDATE skill_proposals SET status = ?, decided_at = ? WHERE id = ?', decision, nowIso(), id);
    this.bus.publish('skills.updated', { proposal: id });
    return get<SkillProposal>(this.db, 'SELECT * FROM skill_proposals WHERE id = ?', id)!;
  }
}
