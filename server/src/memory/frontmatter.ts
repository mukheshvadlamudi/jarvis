export interface ParsedNote {
  data: Record<string, unknown>;
  body: string;
  hasFrontmatter: boolean;
}

function scalar(raw: string): unknown {
  const v = raw.trim();
  if (v === '') return '';
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  if (v.startsWith('[') && v.endsWith(']')) {
    return v
      .slice(1, -1)
      .split(',')
      .map((x) => scalar(x))
      .filter((x) => x !== '');
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/**
 * Minimal YAML frontmatter reader for Obsidian notes: `key: value`, inline `[a, b]` lists and
 * block lists (`- item`). Anything fancier is kept as a raw string.
 */
export function parseFrontmatter(text: string): ParsedNote {
  const src = text.replace(/^﻿/, '');
  if (!src.startsWith('---')) return { data: {}, body: src, hasFrontmatter: false };
  const end = src.search(/\r?\n---\s*(\r?\n|$)/);
  if (end < 0) return { data: {}, body: src, hasFrontmatter: false };
  const head = src.slice(src.indexOf('\n') + 1, end + 1);
  const after = src.slice(end).replace(/^\r?\n---\s*(\r?\n)?/, '');
  const data: Record<string, unknown> = {};
  let listKey: string | null = null;
  for (const line of head.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (data[listKey] as unknown[]).push(scalar(item[1]));
      continue;
    }
    const kv = /^([A-Za-z0-9_\- ]+):\s*(.*)$/.exec(line);
    if (kv) {
      const key = kv[1].trim();
      if (kv[2].trim() === '') {
        data[key] = [];
        listKey = key;
      } else {
        data[key] = scalar(kv[2]);
        listKey = null;
      }
    }
  }
  for (const [k, v] of Object.entries(data)) if (Array.isArray(v) && v.length === 0) data[k] = null;
  return { data, body: after, hasFrontmatter: true };
}

export function firstHeading(body: string): string | null {
  const m = /^#\s+(.+)$/m.exec(body);
  return m ? m[1].trim() : null;
}

export function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v) return v.split(/[,\s]+/).filter(Boolean);
  return [];
}
