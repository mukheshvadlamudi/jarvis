import { createHash } from 'node:crypto';
import type { Services } from '../app.ts';
import { all, get, run } from '../db/index.ts';
import { newId, nowIso } from '../util/ids.ts';
import { logger } from '../util/log.ts';

const log = logger('feeds');

export interface FeedSource {
  id: string;
  name: string;
  url: string;
  kind: 'rss' | 'atom' | 'github' | 'page';
  enabled: number;
  last_checked_at: string | null;
  last_error: string | null;
  page_hash: string | null;
  created_at: string;
}

export interface ParsedItem {
  guid: string;
  title: string;
  url: string;
  published_at: string | null;
  summary: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

/** Strip markup to plain text (feeds embed HTML, sometimes double-escaped). */
export function plainText(html: string, max = 400): string {
  let s = html.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = decodeEntities(s);
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : null;
}

function isoOrNull(v: string | null): string | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Parse RSS 2.0 or Atom (incl. GitHub releases.atom) with a tolerant regex reader — no XML dependency. */
export function parseFeed(xml: string): { title: string | null; items: ParsedItem[] } {
  const isAtom = /<feed[\s>]/i.test(xml);
  const items: ParsedItem[] = [];
  if (isAtom) {
    for (const m of xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)) {
      const e = m[0];
      const link = /<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i.exec(e)?.[1] ?? /<link[^>]*href=["']([^"']+)["']/i.exec(e)?.[1] ?? '';
      const title = plainText(tag(e, 'title') ?? '', 300);
      items.push({
        guid: tag(e, 'id') ?? link ?? title,
        title: title || link,
        url: decodeEntities(link),
        published_at: isoOrNull(tag(e, 'published') ?? tag(e, 'updated')),
        summary: plainText(tag(e, 'content') ?? tag(e, 'summary') ?? ''),
      });
    }
  } else {
    for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
      const e = m[0];
      const link = decodeEntities(tag(e, 'link') ?? '');
      const title = plainText(tag(e, 'title') ?? '', 300);
      items.push({
        guid: tag(e, 'guid') ?? link ?? title,
        title: title || link,
        url: link,
        published_at: isoOrNull(tag(e, 'pubDate') ?? tag(e, 'dc:date')),
        summary: plainText(tag(e, 'description') ?? tag(e, 'content:encoded') ?? ''),
      });
    }
  }
  const head = isAtom ? xml.split(/<entry[\s>]/i)[0] : xml.split(/<item[\s>]/i)[0];
  return { title: tag(head, 'title') ? plainText(tag(head, 'title')!, 120) : null, items: items.filter((i) => i.url || i.title) };
}

export function detectKind(url: string, body: string): FeedSource['kind'] {
  if (/github\.com\/[^/]+\/[^/]+\/releases\.atom/i.test(url)) return 'github';
  if (/<feed[\s>]/i.test(body)) return 'atom';
  if (/<rss[\s>]|<rdf:RDF/i.test(body)) return 'rss';
  return 'page';
}

export type Fetcher = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** RSS/Atom/GitHub releases and plain pages (hash-diff). Plain `fetch`, no LLM. */
export class Feeds {
  private s: Services;
  fetcher: Fetcher = (url, init) => fetch(url, init);
  private timer: NodeJS.Timeout | null = null;

  constructor(s: Services) {
    this.s = s;
  }

  sources(): Array<FeedSource & { unseen: number; total: number }> {
    return all(this.s.db, `SELECT f.*, (SELECT COUNT(*) FROM feed_items i WHERE i.source_id = f.id AND i.seen = 0) AS unseen,
      (SELECT COUNT(*) FROM feed_items i WHERE i.source_id = f.id) AS total FROM feed_sources f ORDER BY f.name`);
  }

  source(id: string): FeedSource | undefined {
    return get<FeedSource>(this.s.db, 'SELECT * FROM feed_sources WHERE id = ?', id);
  }

  items(opts: { unseen?: boolean; source?: string; limit?: number } = {}) {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts.unseen) where.push('i.seen = 0');
    if (opts.source) {
      where.push('i.source_id = ?');
      params.push(opts.source);
    }
    return all<{ id: string; source_id: string; source: string; kind: string; title: string; url: string; published_at: string | null; summary: string; seen: number }>(
      this.s.db,
      `SELECT i.id, i.source_id, f.name AS source, f.kind, i.title, i.url, i.published_at, i.summary, i.seen FROM feed_items i JOIN feed_sources f ON f.id = i.source_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY COALESCE(i.published_at, i.fetched_at) DESC LIMIT ?`,
      ...params, Math.min(opts.limit ?? 100, 500),
    );
  }

  async add(input: { url: string; name?: string }): Promise<FeedSource> {
    const url = input.url.trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('Use a full http(s) URL.');
    if (get(this.s.db, 'SELECT id FROM feed_sources WHERE url = ?', url)) throw new Error('You already follow that URL.');
    let kind: FeedSource['kind'] = /releases\.atom$/i.test(url) ? 'github' : 'page';
    let name = input.name?.trim() || '';
    try {
      const res = await this.fetcher(url, { signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'Jarvis/0.1 (+personal feed reader)' } });
      const body = await res.text();
      kind = detectKind(url, body);
      if (!name) name = (kind === 'page' ? /<title>([^<]*)<\/title>/i.exec(body)?.[1]?.trim() : parseFeed(body).title) || new URL(url).hostname;
    } catch {
      name ||= new URL(url).hostname;
    }
    const id = newId('f');
    run(this.s.db, 'INSERT INTO feed_sources (id, name, url, kind, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)', id, decodeEntities(name).slice(0, 120), url, kind, nowIso());
    await this.fetchOne(id);
    return this.source(id)!;
  }

  async fetchOne(id: string): Promise<{ added: number; error?: string }> {
    const src = this.source(id);
    if (!src) throw new Error('not_found');
    const now = nowIso();
    try {
      const res = await this.fetcher(src.url, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'Jarvis/0.1 (+personal feed reader)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.text()).slice(0, 2_000_000);
      let added = 0;
      if (src.kind === 'page') {
        const text = plainText(body, 200_000);
        const hash = createHash('sha1').update(text).digest('hex');
        if (src.page_hash && src.page_hash !== hash) {
          added += this.insert(src.id, { guid: `${hash}`, title: `${src.name} changed`, url: src.url, published_at: now, summary: text.slice(0, 400) }, now);
        }
        run(this.s.db, 'UPDATE feed_sources SET page_hash = ?, last_checked_at = ?, last_error = NULL WHERE id = ?', hash, now, src.id);
      } else {
        for (const item of parseFeed(body).items.slice(0, 50)) added += this.insert(src.id, item, now);
        run(this.s.db, 'UPDATE feed_sources SET last_checked_at = ?, last_error = NULL WHERE id = ?', now, src.id);
      }
      if (added) this.s.bus.publish('feed.updated', { source: src.id, added });
      return { added };
    } catch (err) {
      const error = (err as Error).message;
      run(this.s.db, 'UPDATE feed_sources SET last_checked_at = ?, last_error = ? WHERE id = ?', now, error, src.id);
      this.s.bus.publish('feed.updated', { source: src.id, error });
      return { added: 0, error };
    }
  }

  private insert(sourceId: string, item: ParsedItem, now: string): number {
    const r = run(
      this.s.db,
      `INSERT OR IGNORE INTO feed_items (id, source_id, guid, title, url, published_at, summary, seen, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      newId('fi'), sourceId, item.guid.slice(0, 500), item.title.slice(0, 300), item.url, item.published_at, item.summary, now,
    );
    return r.changes;
  }

  async fetchAll(): Promise<{ added: number; errors: number }> {
    let added = 0;
    let errors = 0;
    for (const src of this.sources().filter((x) => x.enabled)) {
      const r = await this.fetchOne(src.id);
      added += r.added;
      if (r.error) errors++;
    }
    return { added, errors };
  }

  markSeen(ids: string[] | 'all', before?: string): number {
    if (ids === 'all') return run(this.s.db, `UPDATE feed_items SET seen = 1 WHERE seen = 0 ${before ? 'AND fetched_at <= ?' : ''}`, ...(before ? [before] : [])).changes;
    let n = 0;
    for (const id of ids) n += run(this.s.db, 'UPDATE feed_items SET seen = 1 WHERE id = ?', id).changes;
    return n;
  }

  /** Fetch every N hours (cheap; skipped in mock mode unless JARVIS_FEEDS_FETCH=1). */
  start(hours: () => number): void {
    const tick = () => void this.fetchAll().catch((err) => log.warn('feed fetch failed', err));
    const due = this.sources().every((x) => !x.last_checked_at || Date.now() - Date.parse(x.last_checked_at) > hours() * 3600_000);
    if (due) tick();
    this.timer = setInterval(tick, hours() * 3600_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
