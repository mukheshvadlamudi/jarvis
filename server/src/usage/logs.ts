import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface FileCursor {
  size: number;
  mtimeMs: number;
  offset: number;
}

/** Recursively list `*.jsonl` files modified after `sinceMs`. Skips huge trees cheaply by mtime. */
export function listJsonl(root: string, sinceMs = 0, depth = 6): Array<{ path: string; mtimeMs: number; size: number }> {
  const out: Array<{ path: string; mtimeMs: number; size: number }> = [];
  const walk = (dir: string, d: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (d > 0) walk(p, d - 1);
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          const st = statSync(p);
          if (st.mtimeMs > sinceMs) out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          // file vanished between readdir and stat
        }
      }
    }
  };
  walk(root, depth);
  return out;
}

/**
 * Read complete lines appended since `cursor.offset` without loading the whole file. Returns the
 * parsed JSON objects and the new cursor. A truncated/rotated file restarts from 0.
 */
export function readNewJsonLines(path: string, cursor: FileCursor | undefined, maxBytes = 8 * 1024 * 1024): { lines: unknown[]; cursor: FileCursor } {
  const st = statSync(path);
  let offset = cursor && cursor.size <= st.size ? cursor.offset : 0;
  // For very large first reads, only look at the tail; plan windows are at most 7 days old.
  if (st.size - offset > maxBytes) offset = st.size - maxBytes;
  const lines: unknown[] = [];
  if (st.size <= offset) return { lines, cursor: { size: st.size, mtimeMs: st.mtimeMs, offset } };
  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let pos = offset;
    let carry = '';
    let consumed = offset;
    while (pos < st.size) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, st.size - pos), pos);
      if (n <= 0) break;
      pos += n;
      const text = carry + chunk.subarray(0, n).toString('utf8');
      const parts = text.split('\n');
      carry = parts.pop() ?? '';
      for (const line of parts) {
        consumed += Buffer.byteLength(line, 'utf8') + 1;
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          lines.push(JSON.parse(trimmed));
        } catch {
          // partial or non-JSON line (e.g. first line after a tail seek)
        }
      }
    }
    return { lines, cursor: { size: st.size, mtimeMs: st.mtimeMs, offset: consumed } };
  } finally {
    closeSync(fd);
  }
}
