import { existsSync } from 'node:fs';
import type { JarvisConfig } from '../config.ts';
import type { BuiltContext, ContextItem, ContextProvider } from '../tasks/context.ts';
import { estimateTokens, JARVIS_INSTRUCTIONS } from '../tasks/context.ts';
import type { Project, Task } from '../types.ts';
import type { VaultIndex } from './vault.ts';

interface Part {
  item: ContextItem;
  heading: string;
  text: string;
  priority: number;
}

export function projectNotePath(project: Pick<Project, 'name' | 'vault_note'>): string {
  return project.vault_note || `Projects/${project.name}.md`;
}

function trimToTokens(text: string, tokens: number): string {
  if (tokens <= 0) return '';
  const chars = tokens * 4;
  if (text.length <= chars) return text;
  const cut = text.slice(0, chars);
  const nl = cut.lastIndexOf('\n');
  return `${nl > chars * 0.6 ? cut.slice(0, nl) : cut}\n[… trimmed to fit the context budget; read the full note with read_note]`;
}

/**
 * SPEC §9 context: Jarvis instructions + CORE.md + the task's project note + skill names and one-line
 * descriptions. Over budget → trim the lowest-priority parts first (skills, then project, then core).
 */
export function memoryContextProvider(vault: VaultIndex, skills: () => Array<{ name: string; description: string }>, cfg: () => JarvisConfig): ContextProvider {
  return {
    build(_task: Task, project: Project | undefined): BuiltContext {
      const budget = cfg().memory.contextBudgetTokens;
      const parts: Part[] = [];
      parts.push({ item: { label: 'Jarvis instructions', kind: 'instructions', tokens: 0 }, heading: '', text: JARVIS_INSTRUCTIONS, priority: 0 });
      const core = existsSync(vault.resolve('CORE.md')) ? vault.read('CORE.md') : null;
      if (core) parts.push({ item: { label: 'CORE.md', kind: 'core', path: 'CORE.md', tokens: 0 }, heading: "## Owner's core memory (CORE.md)", text: core.body.trim(), priority: 1 });
      if (project) {
        const rel = projectNotePath(project);
        let note = null;
        try {
          note = vault.read(rel);
        } catch {
          note = null;
        }
        if (note) parts.push({ item: { label: `Project: ${project.name}`, kind: 'project', path: note.path, tokens: 0 }, heading: `## Project: ${project.name} (${note.path})`, text: note.body.trim(), priority: 2 });
      }
      const list = skills();
      if (list.length) {
        parts.push({
          item: { label: `Skill descriptions (${list.length})`, kind: 'skills', tokens: 0 },
          heading: '## Skills (read Skills/<name>/SKILL.md with read_note when one applies)',
          text: list.map((s) => `- ${s.name}: ${s.description}`).join('\n'),
          priority: 3,
        });
      }
      for (const p of parts) p.item.tokens = estimateTokens(p.heading + p.text) + 2;
      let total = parts.reduce((n, p) => n + p.item.tokens, 0);
      let truncated = false;
      for (const p of [...parts].sort((a, b) => b.priority - a.priority)) {
        if (p.priority === 0) break;
        for (let attempt = 0; attempt < 4 && total > budget && p.text; attempt++) {
          const over = total - budget;
          const keep = Math.max(0, p.item.tokens - over - 40 * (attempt + 1));
          p.text = keep < 60 ? '' : trimToTokens(p.text, keep);
          const before = p.item.tokens;
          p.item.tokens = p.text ? estimateTokens(p.heading + p.text) + 2 : 0;
          p.item.truncated = true;
          total -= before - p.item.tokens;
          truncated = true;
        }
        if (total <= budget) break;
      }
      const kept = parts.filter((p) => p.text);
      const prefix = kept.map((p) => (p.heading ? `${p.heading}\n${p.text}` : p.text)).join('\n\n');
      return {
        prefix: `<jarvis-context>\n${prefix}\n</jarvis-context>`,
        report: { items: kept.map((p) => p.item), totalTokens: kept.reduce((n, p) => n + p.item.tokens, 0), budgetTokens: budget, truncated },
      };
    },
  };
}
