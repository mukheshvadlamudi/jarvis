import type { Definition, RunDetail, Step } from '../../../server/src/workflows/model.ts';
export type { Definition, RunDetail, Step };
export type Workflow = Definition & { builtIn: boolean };
export interface WorkflowList { workflows: Workflow[]; runs: RunDetail[]; errors: string[] }

export function shortcut(text: string, workflows: Workflow[]) {
  const match = /^(\/\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const definition = workflows.find(w => w.triggers.some(t => t.toLowerCase() === match[1].toLowerCase()));
  return definition ? { definition, input: match[2]?.trim() ?? '' } : null;
}
