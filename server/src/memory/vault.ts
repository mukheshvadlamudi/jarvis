import { existsSync, readFileSync, readdirSync, statSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import type { Db } from '../db/index.ts';
import { all, get, run, tx } from '../db/index.ts';
import type { EventBus } from '../events.ts';
import { estimateTokens } from '../tasks/context.ts';
import { logger } from '../util/log.ts';
import { asList, firstHeading, parseFrontmatter } from './frontmatter.ts';

const log = logger('vault');

export interface NoteRow {
  path: string;
  title: string;
  type: string | null;
  status: string | null;
  tags: string | null;
  updated: string | null;
  project: string | null;
  tokens: number;
  mtime: number;
  frontmatter_json: string | null;
}

export interface SearchHit {
  path: string;
  title: string;
  type: string | null;
  snippet: string;
  tokens: number;
  updated: string | null;
}

export interface Note {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
  content: string;
  tokens: number;
  mtime: number;
}

/** Vault-relative paths always use forward slashes. */
export const toRel = (p: string) => p.split(sep).join('/');

export function isIgnored(rel: string): boolean {
  const parts = rel.split('/');
  if (parts.some((p) => p.startsWith('.') || p === 'node_modules')) return true;
  return !rel.toLowerCase().endsWith('.md');
}

/** Indexes the Obsidian vault into SQLite (notes_index + FTS5, or a LIKE fallback). */
export class VaultIndex {
  readonly root: string;
  readonly fts: boolean;
  private db: Db;
  private bus: EventBus;
  private watcher: FSWatcher | null = null;
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(db: Db, root: string, bus: EventBus) {
    this.db = db;
    this.root = resolve(root);
    this.bus = bus;
    let fts = true;
    try {
      db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(path UNINDEXED, title, body, tokenize = 'porter unicode61')");
    } catch (err) {
      fts = false;
      log.warn('SQLite FTS5 is not available; memory search falls back to LIKE (slower, no ranking)', err);
    }
    this.fts = fts;
  }

  /** Resolve a vault-relative path, refusing anything that escapes the vault. */
  resolve(rel: string): string {
    const clean = normalize(rel.replace(/\\/g, '/')).replace(/^([/\\])+/, '');
    const abs = resolve(this.root, clean);
    const r = relative(this.root, abs);
    if (r.startsWith('..') || isAbsolute(r)) throw new Error('path is outside the vault');
    return abs;
  }

  private walk(dir: string, out: string[]): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) this.walk(p, out);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(toRel(relative(this.root, p)));
    }
  }

  /** Full scan: index new/changed notes, drop deleted ones. Returns the number of changed notes. */
  indexAll(): number {
    if (!existsSync(this.root)) {
      log.warn(`vault not found at ${this.root}`);
      return 0;
    }
    const files: string[] = [];
    this.walk(this.root, files);
    const known = new Map(all<{ path: string; mtime: number }>(this.db, 'SELECT path, mtime FROM notes_index').map((r) => [r.path, r.mtime]));
    let changed = 0;
    tx(this.db, () => {
      for (const rel of files) {
        const mtime = statSync(join(this.root, rel)).mtimeMs;
        if (known.get(rel) === mtime) {
          known.delete(rel);
          continue;
        }
        known.delete(rel);
        this.upsert(rel);
        changed++;
      }
      for (const gone of known.keys()) {
        this.remove(gone);
        changed++;
      }
    });
    if (changed) this.bus.publish('memory.updated', { changed });
    return changed;
  }

  indexFile(rel: string): void {
    if (isIgnored(rel)) return;
    const abs = this.resolve(rel);
    if (existsSync(abs)) this.upsert(rel);
    else this.remove(rel);
  }

  private upsert(rel: string): void {
    const abs = join(this.root, rel);
    const content = readFileSync(abs, 'utf8');
    const { data, body } = parseFrontmatter(content);
    const name = rel.split('/').pop()!.replace(/\.md$/i, '');
    const title = (typeof data.title === 'string' && data.title) || firstHeading(body) || name;
    const folderType = rel.startsWith('Projects/') ? 'project' : rel.startsWith('People/') ? 'person' : rel.startsWith('Areas/') ? 'area' : rel.startsWith('Research/') ? 'research' : rel.startsWith('Journal/') ? 'journal' : rel.startsWith('Skills/') ? 'skill' : null;
    const type = (typeof data.type === 'string' && data.type) || folderType || (rel === 'CORE.md' ? 'core' : null);
    const tokens = estimateTokens(content);
    const mtime = statSync(abs).mtimeMs;
    run(
      this.db,
      `INSERT INTO notes_index (path, title, type, status, tags, updated, project, tokens, mtime, frontmatter_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET title = excluded.title, type = excluded.type, status = excluded.status, tags = excluded.tags,
         updated = excluded.updated, project = excluded.project, tokens = excluded.tokens, mtime = excluded.mtime, frontmatter_json = excluded.frontmatter_json`,
      rel, title, type, data.status == null ? null : String(data.status), asList(data.tags).join(',') || null,
      data.updated == null ? null : String(data.updated), data.project == null ? null : String(data.project), tokens, mtime, JSON.stringify(data),
    );
    run(this.db, 'INSERT INTO notes_body (path, body) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET body = excluded.body', rel, body);
    if (this.fts) {
      run(this.db, 'DELETE FROM notes_fts WHERE path = ?', rel);
      run(this.db, 'INSERT INTO notes_fts (path, title, body) VALUES (?, ?, ?)', rel, title, body);
    }
  }

  private remove(rel: string): void {
    run(this.db, 'DELETE FROM notes_index WHERE path = ?', rel);
    run(this.db, 'DELETE FROM notes_body WHERE path = ?', rel);
    if (this.fts) run(this.db, 'DELETE FROM notes_fts WHERE path = ?', rel);
  }

  /** Watch the vault (debounced) so edits in Obsidian show up without a restart. */
  watch(debounceMs = 600): void {
    if (this.watcher || !existsSync(this.root)) return;
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const rel = toRel(String(filename));
        if (isIgnored(rel)) return;
        this.pending.add(rel);
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), debounceMs);
      });
      this.watcher.on('error', (err) => log.warn('vault watcher error', err));
    } catch (err) {
      log.warn('fs.watch is unavailable for the vault; changes are picked up on restart or reindex', err);
    }
  }

  flush(): void {
    const paths = [...this.pending];
    this.pending.clear();
    if (!paths.length) return;
    tx(this.db, () => {
      for (const p of paths) {
        try {
          this.indexFile(p);
        } catch (err) {
          log.warn(`could not index ${p}`, err);
        }
      }
    });
    this.bus.publish('memory.updated', { changed: paths.length, paths });
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
  }

  search(q: string, opts: { limit?: number; type?: string } = {}): SearchHit[] {
    const limit = Math.min(opts.limit ?? 20, 100);
    const words = q.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!words.length) return [];
    if (this.fts) {
      const match = words.map((w) => `"${w.replace(/"/g, '')}"*`).join(' ');
      try {
        return all<SearchHit>(
          this.db,
          `SELECT f.path, i.title, i.type, i.tokens, i.updated,
             snippet(notes_fts, 2, char(1), char(2), '…', 14) AS snippet
           FROM notes_fts f JOIN notes_index i ON i.path = f.path
           WHERE notes_fts MATCH ? ${opts.type ? 'AND i.type = ?' : ''}
           ORDER BY bm25(notes_fts, 0, 8.0, 1.0) LIMIT ?`,
          match, ...(opts.type ? [opts.type] : []), limit,
        );
      } catch (err) {
        log.debug('fts query failed, using LIKE', err);
      }
    }
    const where = words.map(() => '(lower(i.title) LIKE ? OR lower(b.body) LIKE ?)').join(' AND ');
    const params = words.flatMap((w) => [`%${w}%`, `%${w}%`]);
    const rows = all<SearchHit & { body: string }>(
      this.db,
      `SELECT i.path, i.title, i.type, i.tokens, i.updated, b.body FROM notes_index i JOIN notes_body b ON b.path = i.path
       WHERE ${where} ${opts.type ? 'AND i.type = ?' : ''} ORDER BY i.mtime DESC LIMIT ?`,
      ...params, ...(opts.type ? [opts.type] : []), limit,
    );
    return rows.map(({ body, ...r }) => {
      const w0 = words[0] ?? '';
      const idx = body.toLowerCase().indexOf(w0);
      const start = Math.max(0, idx - 60);
      const raw = body.slice(start, start + 160).replace(/\s+/g, ' ');
      return { ...r, snippet: `${start > 0 ? '…' : ''}${raw.replace(new RegExp(w0.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), (m) => `\u0001${m}\u0002`)}…` };
    });
  }

  read(rel: string): Note | null {
    const abs = this.resolve(rel);
    if (!existsSync(abs) || !abs.toLowerCase().endsWith('.md')) return null;
    const content = readFileSync(abs, 'utf8');
    const { data, body } = parseFrontmatter(content);
    const path = toRel(relative(this.root, abs));
    const row = get<NoteRow>(this.db, 'SELECT * FROM notes_index WHERE path = ?', path);
    return { path, title: row?.title ?? firstHeading(body) ?? path, frontmatter: data, body, content, tokens: estimateTokens(content), mtime: statSync(abs).mtimeMs };
  }

  list(opts: { type?: string; prefix?: string } = {}): NoteRow[] {
    const where: string[] = [];
    const params: string[] = [];
    if (opts.type) {
      where.push('type = ?');
      params.push(opts.type);
    }
    if (opts.prefix) {
      where.push('path LIKE ?');
      params.push(`${opts.prefix}%`);
    }
    return all<NoteRow>(this.db, `SELECT * FROM notes_index ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY path`, ...params);
  }

  count(): number {
    return get<{ n: number }>(this.db, 'SELECT COUNT(*) AS n FROM notes_index')?.n ?? 0;
  }
}
