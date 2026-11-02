import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/index.ts';
import { all, get, run, tx } from '../db/index.ts';
import type { EventBus } from '../events.ts';
import { newId, nowIso, slugify } from '../util/ids.ts';
import { parseFrontmatter } from '../memory/frontmatter.ts';

export interface Skill {
  id: string;
  name: string;
  description: string;
  path: string;
  source: string;
  enabled: number;
  updated_at: string;
  synced_at: string | null;
  hash: string | null;
}

export const skillHash = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 12);

/** Canonical skills live in `<vault>/Skills/<name>/SKILL.md` with `name` + `description` frontmatter. */
export class SkillRegistry {
  private db: Db;
  private bus: EventBus;
  readonly vault: string;

  constructor(db: Db, vault: string, bus: EventBus) {
    this.db = db;
    this.vault = vault;
    this.bus = bus;
  }

  get dir(): string {
    return join(this.vault, 'Skills');
  }

  scan(): Skill[] {
    const found = new Map<string, { description: string; path: string; hash: string }>();
    if (existsSync(this.dir)) {
      for (const e of readdirSync(this.dir, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const file = join(this.dir, e.name, 'SKILL.md');
        if (!existsSync(file)) continue;
        const text = readFileSync(file, 'utf8');
        const { data } = parseFrontmatter(text);
        const name = typeof data.name === 'string' && data.name.trim() ? slugify(data.name, 60) : slugify(e.name, 60);
        const description = typeof data.description === 'string' ? data.description.trim() : '';
        found.set(name, { description, path: `Skills/${e.name}/SKILL.md`, hash: skillHash(text) });
      }
    }
    tx(this.db, () => {
      for (const [name, s] of found) {
        const cur = get<Skill>(this.db, 'SELECT * FROM skills WHERE name = ?', name);
        if (!cur) {
          run(this.db, 'INSERT INTO skills (id, name, description, path, source, enabled, updated_at, hash) VALUES (?, ?, ?, ?, ?, 1, ?, ?)', newId('s'), name, s.description, s.path, 'vault', nowIso(), s.hash);
        } else if (cur.hash !== s.hash || cur.path !== s.path || cur.description !== s.description) {
          run(this.db, 'UPDATE skills SET description = ?, path = ?, hash = ?, updated_at = ? WHERE id = ?', s.description, s.path, s.hash, nowIso(), cur.id);
        }
      }
      for (const s of this.list()) if (!found.has(s.name)) run(this.db, 'DELETE FROM skills WHERE id = ?', s.id);
    });
    this.bus.publish('skills.updated', {});
    return this.list();
  }

  list(): Skill[] {
    return all<Skill>(this.db, 'SELECT * FROM skills ORDER BY name');
  }

  enabled(): Skill[] {
    return all<Skill>(this.db, 'SELECT * FROM skills WHERE enabled = 1 ORDER BY name');
  }

  get(name: string): Skill | undefined {
    return get<Skill>(this.db, 'SELECT * FROM skills WHERE name = ? OR id = ?', name, name);
  }

  setEnabled(nameOrId: string, enabled: boolean): Skill {
    const s = this.get(nameOrId);
    if (!s) throw new Error('not_found');
    run(this.db, 'UPDATE skills SET enabled = ?, updated_at = ? WHERE id = ?', enabled ? 1 : 0, nowIso(), s.id);
    this.bus.publish('skills.updated', {});
    return this.get(s.id)!;
  }

  read(name: string): string | null {
    const s = this.get(name);
    if (!s) return null;
    const file = join(this.vault, s.path);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  }

  /** Write (create or replace) a skill in the vault and re-register it. */
  write(name: string, description: string, body: string): Skill {
    const slug = slugify(name, 60);
    if (!slug) throw new Error('skill name is required');
    const dir = join(this.dir, slug);
    mkdirSync(dir, { recursive: true });
    const text = body.trimStart().startsWith('---')
      ? body
      : `---\nname: ${slug}\ndescription: ${description.replace(/\n/g, ' ').trim()}\n---\n${body.trim()}\n`;
    writeFileSync(join(dir, 'SKILL.md'), text.endsWith('\n') ? text : `${text}\n`);
    this.scan();
    return this.get(slug)!;
  }
}

export const CONNECTOR_TEMPLATES: Record<string, { description: string; body: string }> = {
  gmail: {
    description: 'Rules for using Gmail — VIPs, labels, signature, and what always needs approval. No credentials here.',
    body: `# Gmail\n\n## VIPs (surface first)\n- name@example.com\n\n## Labels\n- \`receipts\` — invoices and receipts\n- \`clients/<name>\` — per-client threads\n\n## Signature\nBest, <your name>\n\n## Always needs approval\n- Sending, replying, forwarding, deleting, or changing filters.\n`,
  },
  calendar: {
    description: 'Rules for Google Calendar — focus hours, meeting preferences, and that creating or changing events needs approval.',
    body: `# Calendar\n\n- Focus block: 08:00–12:00 weekdays.\n- Default meeting length: 30 min with a 15 min buffer.\n- Creating, moving, declining or deleting events always needs approval.\n`,
  },
  drive: {
    description: 'Where things live in Google Drive and which actions (sharing, deleting) need approval.',
    body: `# Drive\n\n- Receipts: \`Finances/<tax year>/Receipts\`.\n- Client files: \`Clients/<name>\`.\n- Sharing outside my account and deleting files always need approval.\n`,
  },
  browser: {
    description: 'How to use the browser for research and admin — read-only by default; forms, purchases and logins need approval.',
    body: `# Browser\n\n- Prefer primary sources; note dates on time-sensitive facts.\n- Submitting forms, buying, booking or logging in needs approval.\n- Never read or export saved passwords or cookies.\n`,
  },
};
