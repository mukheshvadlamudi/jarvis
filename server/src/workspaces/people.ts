import type { Services } from '../app.ts';
import { all } from '../db/index.ts';
import type { MemoryModule } from '../memory/module.ts';
import { parseFrontmatter } from '../memory/frontmatter.ts';

export interface Person {
  path: string;
  name: string;
  company: string | null;
  role: string | null;
  email: string | null;
  last_contact: string | null;
  follow_up: string | null;
  tags: string[];
  openThreads: string[];
}

/** "Open threads" list items from a People note body. */
export function openThreads(body: string): string[] {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => /open threads/i.test(l));
  if (start < 0) return [];
  const base = /^(\s*)/.exec(lines[start])![1].length;
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    const m = /^(\s*)[-*]\s+(.*)$/.exec(l);
    if (!m || m[1].length <= base) break;
    out.push(m[2].trim());
  }
  return out;
}

function str(v: unknown): string | null {
  return v === null || v === undefined || v === '' ? null : String(v);
}

export function listPeople(s: Services): Person[] {
  const mem = s.modules.memory as MemoryModule | undefined;
  if (!mem) return [];
  const rows = all<{ path: string }>(s.db, "SELECT path FROM notes_index WHERE path LIKE 'People/%' ORDER BY path");
  const out: Person[] = [];
  for (const r of rows) {
    const note = mem.vault.read(r.path);
    if (!note) continue;
    const fm = note.frontmatter;
    out.push({
      path: r.path,
      name: note.title,
      company: str(fm.company),
      role: str(fm.role),
      email: str(fm.email),
      last_contact: str(fm.last_contact),
      follow_up: str(fm.follow_up),
      tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [],
      openThreads: openThreads(note.body),
    });
  }
  return out.sort((a, b) => (a.follow_up ?? '9999').localeCompare(b.follow_up ?? '9999') || a.name.localeCompare(b.name));
}

/** Owner action: mark contacted today and/or set the next follow-up (rewrites frontmatter only). */
export function touchPerson(s: Services, path: string, opts: { contacted?: boolean; followUp?: string | null }, today = new Date()): void {
  const mem = s.modules.memory as MemoryModule | undefined;
  if (!mem || !path.startsWith('People/')) throw new Error('Not a People note');
  const note = mem.vault.read(path);
  if (!note) throw new Error('not_found');
  const { body } = parseFrontmatter(note.content);
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const set: Record<string, string | null> = {};
  if (opts.contacted) set.last_contact = date;
  if (opts.followUp !== undefined) {
    if (opts.followUp !== null && !/^\d{4}-\d{2}-\d{2}$/.test(opts.followUp)) throw new Error('follow-up must be YYYY-MM-DD');
    set.follow_up = opts.followUp;
  }
  let head = note.content.startsWith('---') ? note.content.slice(0, note.content.length - body.length) : '---\n---\n';
  for (const [k, v] of Object.entries(set)) {
    const re = new RegExp(`^${k}:.*$`, 'm');
    if (v === null) head = head.replace(new RegExp(`^${k}:.*\\n`, 'm'), '');
    else if (re.test(head)) head = head.replace(re, `${k}: ${v}`);
    else head = head.replace(/\n---\s*\n?$/, `\n${k}: ${v}\n---\n`);
  }
  mem.proposals.propose({ target: path, content: `${head}${body}`, reason: 'Updated from the People page', mode: 'replace', autoApply: true });
}
