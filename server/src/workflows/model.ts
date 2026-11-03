import type { AgentPref, Effort } from '../types.ts';

type Base = { id: string; when?: string; retryOnFail?: number };
export type Step = Base & (
  | { kind: 'agent'; agent: AgentPref; effort?: Effort; model?: string; mode: 'write' | 'read-only'; prompt: string }
  | { kind: 'approval'; summary: string }
  | { kind: 'gather'; sources: string[] }
  | { kind: 'summary'; agent: AgentPref; prompt: string; effort?: Effort }
);
export interface Definition {
  id: string; name: string; description: string; triggers: string[];
  input: { label: string; required: boolean }; steps: Step[];
}
export interface StepResult {
  state: 'running' | 'done' | 'failed' | 'waiting_approval' | 'skipped';
  answer: string; files: string[]; attempts: number; runId?: string; approvalId?: string; agent?: string; handedOver?: boolean;
}
export interface WorkflowRun {
  id: string; workflow_id: string; conversation_id: string;
  status: 'running' | 'waiting_approval' | 'done' | 'failed' | 'cancelled';
  current_step: number; step_results_json: string; definition_json: string;
  started_at: string; ended_at: string | null; input: string; error: string | null;
}
export type RunDetail = WorkflowRun & { definition: Definition; results: Record<string, StepResult>; summary: string };

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const CONDITION = /^steps\.([a-z][a-z0-9-]{0,63})\.answer (contains|not contains|equals) '([^'\n]{1,300})'$/;
const TEMPLATE = /{{([^{}]*)}}/g;
export function render(template: string, input: string, steps: Record<string, Pick<StepResult, 'answer' | 'files'>>): string {
  return template.replace(TEMPLATE, (_, key: string) => {
    if (key === 'input') return input.slice(0, 6000);
    const match = /^steps\.([a-z][a-z0-9-]{0,63})\.(answer|files)$/.exec(key);
    if (!match) return '';
    const result = Object.hasOwn(steps, match[1]) ? steps[match[1]] : undefined;
    const value = match[2] === 'files' ? result?.files.join('\n') : result?.answer;
    return (value ?? '').slice(0, 6000);
  });
}
export function matches(when: string | undefined, steps: Record<string, StepResult>): boolean {
  if (!when) return true;
  const m = CONDITION.exec(when);
  if (!m) return false;
  const value = Object.hasOwn(steps, m[1]) ? steps[m[1]].answer : '';
  return m[2] === 'contains' ? value.includes(m[3]) : m[2] === 'not contains' ? !value.includes(m[3]) : value === m[3];
}

/** Validate the complete trust boundary; references must point backwards in the ordered graph. */
export function validate(value: unknown): Definition {
  const fail = (message: string): never => { throw new Error(message); };
  const object = (v: unknown, label: string): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail(`${label} must be an object`);
  const keys = (v: Record<string, unknown>, allowed: string[], label: string) => { for (const k of Object.keys(v)) if (!allowed.includes(k)) fail(`${label}: unknown field ${k}`); };
  const str = (v: unknown, label: string, max: number, empty = false): string => typeof v === 'string' && (empty || !!v.trim()) && v.length <= max ? v : fail(`${label} must be ${empty ? '0' : '1'}–${max} characters`);
  const d = object(value, 'Workflow');
  keys(d, ['id', 'name', 'description', 'triggers', 'input', 'steps'], 'Workflow');
  if (!ID.test(str(d.id, 'Workflow id', 64))) fail('Workflow id must use lowercase letters, numbers and hyphens');
  str(d.name, 'Name', 120); str(d.description, 'Description', 600, true);
  if (!Array.isArray(d.triggers) || d.triggers.length > 20) fail('Supply at most 20 trigger phrases');
  for (const t of d.triggers as unknown[]) str(t, 'Trigger', 100);
  if (new Set((d.triggers as string[]).map(t => t.trim().toLowerCase())).size !== (d.triggers as string[]).length) fail('Trigger phrases must be unique');
  const input = object(d.input, 'Input'); keys(input, ['label', 'required'], 'Input'); str(input.label, 'Input label', 120);
  if (typeof input.required !== 'boolean') fail('Input required must be true or false');
  if (!Array.isArray(d.steps) || !d.steps.length || d.steps.length > 30) fail('Supply between 1 and 30 steps');
  const seen = new Set<string>();
  const template = (v: unknown, label: string) => {
    const text = str(v, label, 20000);
    for (const m of text.matchAll(TEMPLATE)) {
      if (m[1] === 'input') continue;
      const ref = /^steps\.([a-z][a-z0-9-]{0,63})\.(answer|files)$/.exec(m[1]);
      if (!ref || !seen.has(ref[1])) fail(`${label}: template must reference input or an earlier step's answer/files`);
    }
    if (text.replace(TEMPLATE, '').includes('{{') || text.replace(TEMPLATE, '').includes('}}')) fail(`${label}: unclosed template`);
  };
  for (const [index, value] of (d.steps as unknown[]).entries()) {
    const step = object(value, `Step ${index + 1}`); const label = `Step ${index + 1}`;
    const fields = step.kind === 'agent' ? ['agent','effort','model','mode','prompt'] : step.kind === 'summary' ? ['agent','prompt','effort'] : step.kind === 'approval' ? ['summary'] : step.kind === 'gather' ? ['sources'] : fail(`${label}: choose agent, approval, gather or summary`);
    keys(step, ['id','kind','when','retryOnFail', ...fields], label);
    const id = str(step.id, `${label} id`, 64);
    if (!ID.test(id) || seen.has(id)) fail(`${label}: step ids must be unique lowercase ids`);
    if (step.retryOnFail !== undefined && (!Number.isInteger(step.retryOnFail) || Number(step.retryOnFail) < 0 || Number(step.retryOnFail) > 3)) fail(`${label}: retryOnFail must be 0–3`);
    if (step.when !== undefined) { const m = CONDITION.exec(str(step.when, `${label} condition`, 500)); if (!m || !seen.has(m[1])) fail(`${label}: condition must compare an earlier step, e.g. steps.review.answer contains 'REQUEST CHANGES'`); }
    if (step.kind === 'agent' || step.kind === 'summary') {
      if (!['auto','claude','codex'].includes(String(step.agent))) fail(`${label}: choose auto, claude or codex`);
      if (step.effort !== undefined && !['low','medium','high'].includes(String(step.effort))) fail(`${label}: choose low, medium or high effort`);
      template(step.prompt, `${label} prompt`);
    }
    if (step.kind === 'agent') { if (!['write','read-only'].includes(String(step.mode))) fail(`${label}: choose write or read-only mode`); if (step.model !== undefined) str(step.model, `${label} model`, 120); }
    if (step.kind === 'approval') template(step.summary, `${label} summary`);
    if (step.kind === 'gather') {
      if (!Array.isArray(step.sources) || !step.sources.length || step.sources.length > 10 || step.sources.some(s => typeof s !== 'string' || !/^(usage|agents|schedule|notes:[^\n]{1,120})$/.test(s))) fail(`${label}: sources are usage, agents, schedule or notes:<query>`);
    }
    seen.add(id);
  }
  const result = structuredClone(value) as Definition;
  result.name = result.name.trim(); result.description = result.description.trim(); result.triggers = result.triggers.map(t => t.trim()); result.input.label = result.input.label.trim();
  return result;
}
