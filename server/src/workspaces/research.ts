import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Services } from '../app.ts';
import { get } from '../db/index.ts';
import type { MemoryModule } from '../memory/module.ts';
import { parseFrontmatter } from '../memory/frontmatter.ts';
import type { RunFinishedContext } from '../tasks/orchestrator.ts';
import type { Project } from '../types.ts';
import { slugify } from '../util/ids.ts';

export const RESEARCH_INSTRUCTIONS = `

---
Research output: when you are done, write the full report to report.md in the current working directory.
Structure: a one-line title (# …), the recommendation or answer first, then the details, then a "## Sources" section listing every source you relied on with its URL and the date you accessed it. Plain markdown, no front matter.`;

function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function reportPathFor(title: string, when = new Date()): string {
  return `Research/${localDate(when)}-${slugify(title, 48)}.md`;
}

/** Build the vault note: frontmatter + body, guaranteeing a Sources section. */
export function reportNote(body: string, meta: { taskId: string; project: string | null; title: string; agent: string }, when = new Date()): string {
  let text = parseFrontmatter(body).body.trim();
  if (!/^#\s/m.test(text)) text = `# ${meta.title}\n\n${text}`;
  if (!/^##\s+Sources\b/im.test(text)) text += '\n\n## Sources\n- The agent did not list sources for this report.';
  const fm = ['---', 'type: research', `updated: ${localDate(when)}`, `task: ${meta.taskId}`, `agent: ${meta.agent}`];
  if (meta.project) fm.push(`project: ${meta.project}`);
  fm.push('tags: [research]', '---');
  return `${fm.join('\n')}\n${text}\n`;
}

/**
 * Research tasks (SPEC §12): live web search on, a report.md instruction, and on completion the
 * report is saved to vault/Research/YYYY-MM-DD-<slug>.md (follow-ups update the same note).
 */
export function setupResearch(s: Services): void {
  s.orchestrator.inputHooks.push((task, input) => {
    if (task.type !== 'research') return;
    input.webSearch = true;
    input.allowNetwork = true;
    input.prompt += input.resumeSessionId ? '\n\n(If this changes the findings, update report.md, keeping the Sources section.)' : RESEARCH_INSTRUCTIONS;
  });

  s.orchestrator.afterRun.push((ctx: RunFinishedContext) => {
    if (ctx.task.type !== 'research' || ctx.result.status !== 'done') return;
    const mem = s.modules.memory as MemoryModule | undefined;
    if (!mem) return;
    const file = join(ctx.run.cwd, 'report.md');
    const body = existsSync(file) ? readFileSync(file, 'utf8') : ctx.result.summary;
    if (!body.trim()) return;
    const project = ctx.task.project_id ? get<Project>(s.db, 'SELECT name FROM projects WHERE id = ?', ctx.task.project_id)?.name ?? null : null;
    const target = ctx.task.output_path?.startsWith('Research/') ? ctx.task.output_path : reportPathFor(ctx.task.title);
    const note = reportNote(body, { taskId: ctx.task.id, project, title: ctx.task.title, agent: ctx.run.agent }, new Date());
    mem.proposals.propose({ target, content: note, reason: 'Research report', mode: 'replace', runId: ctx.run.id, autoApply: true });
    s.tasks.setStatus(ctx.task.id, 'done', { output_path: target });
  });
}
