import type { Project, Task } from '../types.ts';

export interface ContextItem {
  label: string;
  kind: 'core' | 'project' | 'skills' | 'instructions' | 'other';
  path?: string;
  tokens: number;
  truncated?: boolean;
}

export interface ContextReport {
  items: ContextItem[];
  totalTokens: number;
  budgetTokens: number;
  truncated: boolean;
}

export interface BuiltContext {
  prefix: string;
  report: ContextReport;
}

export interface ContextProvider {
  build(task: Task, project: Project | undefined): Promise<BuiltContext> | BuiltContext;
}

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export const JARVIS_INSTRUCTIONS = `You are running inside Jarvis, the owner's personal task runner.
- Work only inside the current working directory unless the task says otherwise.
- Anything outward-facing (sending email or messages, posting, pushing to a remote, opening PRs, purchases, deleting files outside this folder) needs the owner's approval: call the Jarvis MCP tool \`request_approval\` with what, why and the exact command/payload, and wait for the decision.
- Use \`search_memory\` / \`read_note\` to look up anything about the owner, their projects or people instead of guessing. Propose durable facts with \`save_memory\`.
- You work alongside a second agent (Claude Code ⇄ Codex). For a decision that matters — a risky design choice, a bug you can't pin down, a review of your diff or draft — call \`consult_agent\` once with a specific question. If the other agent is better suited to the next step, call \`handoff_to_agent\` ("review" or "continue") before you finish.
- Put deliverables (reports, drafts, data, images) as files in the working folder; the owner sees them in the Outputs panel.
- Finish with a short plain-language summary of what you did and anything the owner must do next.`;

/** Phase 1 context: Jarvis instructions only. The memory module replaces this provider. */
export const basicContextProvider = (budgetTokens: () => number): ContextProvider => ({
  build(task) {
    const tokens = estimateTokens(JARVIS_INSTRUCTIONS);
    return {
      prefix: JARVIS_INSTRUCTIONS,
      report: {
        items: [{ label: 'Jarvis instructions', kind: 'instructions', tokens }],
        totalTokens: tokens,
        budgetTokens: budgetTokens(),
        truncated: false,
      },
    };
  },
});
