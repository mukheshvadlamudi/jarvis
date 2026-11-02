import type { Services } from '../app.ts';
import { all } from '../db/index.ts';
import { CONSOLIDATION_PROMPT } from '../memory/maintenance.ts';
import type { AgentPref, Task, TaskType } from '../types.ts';

export interface TaskTemplate {
  title: string;
  body?: string;
  type?: TaskType;
  agent_pref?: AgentPref;
  project_id?: string | null;
  /** Built-in routines build their prompt at fire time from live Jarvis state. */
  routine?: 'morning_brief' | 'inbox_triage' | 'weekly_review' | 'memory_consolidation' | 'updates_digest';
}

export interface BuiltIn {
  key: NonNullable<TaskTemplate['routine']>;
  name: string;
  cron: string;
  description: string;
  template: TaskTemplate;
}

/** Built-in routines (SPEC §11). All ship disabled until the owner turns them on. */
export const BUILT_INS: BuiltIn[] = [
  {
    key: 'morning_brief',
    name: 'Morning brief',
    cron: '0 8 * * 1-5',
    description: "Today's calendar, important unread email, due follow-ups, running and blocked tasks, plan usage.",
    template: { title: 'Morning brief', type: 'admin', routine: 'morning_brief' },
  },
  {
    key: 'inbox_triage',
    name: 'Inbox triage',
    cron: '0 11 * * 1-5',
    description: 'Sort unread email into labels, file receipts, draft replies for VIPs (drafts only).',
    template: { title: 'Inbox triage', type: 'admin', routine: 'inbox_triage' },
  },
  {
    key: 'weekly_review',
    name: 'Weekly review',
    cron: '0 16 * * 5',
    description: 'What got done, what slipped, what is next — and proposed updates to project notes.',
    template: { title: 'Weekly review', type: 'memory', routine: 'weekly_review' },
  },
  {
    key: 'memory_consolidation',
    name: 'Memory consolidation',
    cron: '0 18 * * 0',
    description: 'Dedupe, remove stale facts, move history from Projects into Journal, enforce size caps — as proposals.',
    template: { title: 'Memory consolidation', type: 'memory', routine: 'memory_consolidation' },
  },
  {
    key: 'updates_digest',
    name: 'Updates digest',
    cron: '30 7 * * *',
    description: 'Summarise unseen items from your feeds (releases, blogs, changelogs).',
    template: { title: 'Updates digest', type: 'update', routine: 'updates_digest' },
  },
];

function localDate(d = new Date()): string {
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Follow-ups due today or earlier from People/*.md frontmatter (via the vault index). */
export function dueFollowUps(s: Services, now = new Date(), horizonDays = 0): Array<{ path: string; title: string; follow_up: string }> {
  const today = iso(new Date(now.getTime() + horizonDays * 86400_000));
  const rows = all<{ path: string; title: string; frontmatter_json: string | null }>(s.db, "SELECT path, title, frontmatter_json FROM notes_index WHERE path LIKE 'People/%' OR path LIKE 'Projects/%'");
  const out: Array<{ path: string; title: string; follow_up: string }> = [];
  for (const r of rows) {
    try {
      const fm = JSON.parse(r.frontmatter_json ?? '{}') as { follow_up?: unknown };
      if (typeof fm.follow_up === 'string' && fm.follow_up <= today) out.push({ path: r.path, title: r.title, follow_up: fm.follow_up });
    } catch {
      // ignore malformed frontmatter
    }
  }
  return out.sort((a, b) => a.follow_up.localeCompare(b.follow_up) || a.title.localeCompare(b.title));
}

/** Build the task body for a routine from live Jarvis state at fire time. */
export function routineBody(s: Services, routine: TaskTemplate['routine'], now = new Date()): string {
  const lines: string[] = [];
  switch (routine) {
    case 'morning_brief': {
      const tasks = all<Task>(s.db, "SELECT * FROM tasks WHERE status IN ('running','needs_you','queued','failed') AND updated_at >= ? ORDER BY status", new Date(now.getTime() - 3 * 86400_000).toISOString());
      const u = s.usage.current();
      const pct = (w: { usedPercent: number } | null) => (w ? `${Math.round(w.usedPercent)}%` : 'unknown');
      lines.push(`Morning brief for ${localDate(now)}. Keep it to one screen, plain text, most important first.`);
      lines.push('1. Today’s calendar (use the calendar connector; respect Skills/calendar).');
      lines.push('2. Important unread email from the last 24 h (VIPs first, use the gmail connector; do not send anything).');
      lines.push('3. Follow-ups due (below) and anything blocked.');
      lines.push('4. A short plan for the morning focus block.');
      lines.push('', 'Jarvis state:');
      const due = dueFollowUps(s, now);
      lines.push(due.length ? `- Follow-ups due: ${due.map((d) => `${d.title} (${d.follow_up})`).join('; ')}` : '- No follow-ups due.');
      lines.push(tasks.length ? `- Open tasks: ${tasks.map((t) => `[${t.status}] ${t.title}`).join('; ')}` : '- No running or blocked tasks.');
      lines.push(`- Plan usage: Claude 5h ${pct(u.claude.five_hour)}, weekly ${pct(u.claude.weekly)}; Codex 5h ${pct(u.codex.five_hour)}, weekly ${pct(u.codex.weekly)}.`);
      lines.push('', 'Save the brief with save_memory to today’s Journal/DAILY note (append) under a "Morning brief" heading.');
      break;
    }
    case 'inbox_triage':
      lines.push('Triage unread email from the last day using the gmail connector and Skills/gmail.');
      lines.push('- Apply labels, file receipts to Drive per Skills/drive, and draft (never send) replies for VIPs.');
      lines.push('- Create a Jarvis task with create_task for anything that needs real work.');
      lines.push('- Finish with a five-line summary.');
      break;
    case 'weekly_review': {
      const done = all<Task>(s.db, "SELECT * FROM tasks WHERE status = 'done' AND updated_at >= ?", new Date(now.getTime() - 7 * 86400_000).toISOString());
      lines.push(`Weekly review for the week ending ${localDate(now)}.`);
      lines.push(`Done this week (${done.length}): ${done.slice(0, 40).map((t) => t.title).join('; ') || 'nothing recorded'}.`);
      lines.push('Read this week’s Journal/DAILY notes and each active project note. Propose updates to Projects/* "Current state" sections with save_memory (replace mode).');
      lines.push('Finish with: wins, what slipped, and the top three priorities for next week.');
      break;
    }
    case 'memory_consolidation':
      lines.push(CONSOLIDATION_PROMPT);
      break;
    case 'updates_digest': {
      let unseen: Array<{ title: string; url: string; source: string }> = [];
      try {
        unseen = all(s.db, 'SELECT i.title, i.url, f.name AS source FROM feed_items i JOIN feed_sources f ON f.id = i.source_id WHERE i.seen = 0 ORDER BY i.published_at DESC LIMIT 60');
      } catch {
        unseen = [];
      }
      lines.push('Summarise these unseen updates for the owner: group by source, flag security fixes and breaking changes, skip noise. Plain text, short.');
      lines.push(unseen.length ? unseen.map((u) => `- [${u.source}] ${u.title} — ${u.url}`).join('\n') : '- (No unseen feed items; say so in one line.)');
      break;
    }
    default:
      break;
  }
  return lines.join('\n');
}
