import type { Effort, Project, TaskType } from '../types.ts';
import { OUTWARD_TASK } from '../approvals/policy.ts';

export interface Classification {
  type: TaskType;
  projectId: string | null;
  effort: Effort;
  outward: boolean;
  matched: string[];
}

const TYPE_RULES: Array<[TaskType, RegExp]> = [
  ['memory', /\b(remember|memory|vault|note to self|consolidate|core\.md)\b/i],
  ['update', /\b(updates?|digest|release notes|changelog|what'?s new|feeds?|newsletter)\b/i],
  ['research', /\b(research|compare|find out|investigate|look into|best\b.*\b(tools?|options|ways)|pros and cons|survey|benchmark|alternatives?|which .* should)\b/i],
  ['code', /\b(bug|fix|refactor|implement|code|function|endpoint|api|test(s)?|deploy|build|compile|typescript|python|repo|branch|pr|pull request|migration|css|component|lint|crash|stack ?trace)\b/i],
  ['write', /\b(write|draft|blog|article|post|copy|proposal|outline|essay|summari[sz]e|rewrite|edit (the|my) )\b/i],
  ['admin', /\b(email|inbox|calendar|schedule|meeting|invoice|book|reply|follow ?up|expense|receipt|form|renew|pay|tax)\b/i],
];

const HIGH_EFFORT = /\b(architecture|redesign|migrate|migration|rewrite|end[- ]to[- ]end|across the (codebase|repo)|security audit|deep dive|thorough|comprehensive)\b/i;
const LOW_EFFORT = /\b(quick|small|tiny|typo|rename|one[- ]liner|just check|bump)\b/i;

/**
 * Rules-first classifier (no agent call). Picks type by keyword groups, project by name match,
 * effort by scope words, and flags outward-facing tasks.
 */
export function classify(text: string, projects: Pick<Project, 'id' | 'name'>[]): Classification {
  const matched: string[] = [];
  let type: TaskType = 'other';
  for (const [t, re] of TYPE_RULES) {
    const m = re.exec(text);
    if (m) {
      type = t;
      matched.push(`${t}:${m[0].toLowerCase()}`);
      break;
    }
  }
  let projectId: string | null = null;
  const lower = text.toLowerCase();
  const sorted = [...projects].sort((a, b) => b.name.length - a.name.length);
  for (const p of sorted) {
    const name = p.name.toLowerCase();
    const compact = name.replace(/[\s_-]+/g, '');
    if (lower.includes(name) || (compact.length >= 4 && lower.replace(/[\s_-]+/g, '').includes(compact))) {
      projectId = p.id;
      matched.push(`project:${p.name}`);
      break;
    }
  }
  let effort: Effort = 'medium';
  if (HIGH_EFFORT.test(text)) effort = 'high';
  else if (LOW_EFFORT.test(text) || text.length < 40) effort = 'low';
  const outward = OUTWARD_TASK.test(text);
  if (outward) matched.push('outward');
  return { type, projectId, effort, outward, matched };
}
