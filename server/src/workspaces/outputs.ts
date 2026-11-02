import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Services } from '../app.ts';
import { all } from '../db/index.ts';
import type { MemoryModule } from '../memory/module.ts';

const exec = promisify(execFile);

export type OutputKind = 'markdown' | 'text' | 'code' | 'csv' | 'json' | 'html' | 'image' | 'pdf' | 'office' | 'audio' | 'video' | 'archive' | 'binary';

export interface OutputFile {
  folder: number;
  path: string;
  name: string;
  size: number;
  mtime: string;
  kind: OutputKind;
  changed: boolean;
}

const KINDS: Record<string, OutputKind> = {
  '.md': 'markdown', '.markdown': 'markdown',
  '.txt': 'text', '.log': 'text', '.env.example': 'text',
  '.csv': 'csv', '.tsv': 'csv',
  '.json': 'json', '.jsonl': 'json',
  '.html': 'html', '.htm': 'html',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.svg': 'image', '.avif': 'image',
  '.pdf': 'pdf',
  '.docx': 'office', '.xlsx': 'office', '.pptx': 'office', '.doc': 'office', '.xls': 'office', '.ppt': 'office', '.odt': 'office', '.ods': 'office',
  '.mp3': 'audio', '.wav': 'audio', '.m4a': 'audio', '.ogg': 'audio',
  '.mp4': 'video', '.webm': 'video', '.mov': 'video',
  '.zip': 'archive', '.tar': 'archive', '.gz': 'archive', '.7z': 'archive',
};
const CODE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.cs', '.rb', '.php', '.sh', '.ps1', '.sql', '.css', '.scss', '.yml', '.yaml', '.toml', '.xml', '.ini', '.c', '.cpp', '.h', '.swift', '.kt']);

export const MIME: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif',
  '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
};

export function kindOf(name: string): OutputKind {
  const ext = extname(name).toLowerCase();
  if (KINDS[ext]) return KINDS[ext];
  if (CODE.has(ext)) return 'code';
  return ext === '' ? 'text' : 'binary';
}

export function mimeOf(name: string): string {
  const ext = extname(name).toLowerCase();
  if (MIME[ext]) return MIME[ext];
  const k = kindOf(name);
  return k === 'code' || k === 'text' ? 'text/plain; charset=utf-8' : 'application/octet-stream';
}

const SKIP = new Set(['node_modules', '.git', '.venv', '__pycache__', '.jarvis-worktrees', 'dist', 'build', '.next', 'target']);

function walk(root: string, cap = 500): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (out.length >= cap || depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= cap) return;
      if (e.name.startsWith('.') && e.name !== '.env.example') continue;
      if (SKIP.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) visit(p, depth + 1);
      else if (e.isFile()) out.push(relative(root, p).split(sep).join('/'));
    }
  };
  visit(root, 0);
  return out;
}

/**
 * Files produced by a task's runs, read straight from the working folders so Claude and Codex
 * outputs look the same. Scratch folders are listed fully; git worktrees only show changed files.
 */
export class Outputs {
  private s: Services;

  constructor(s: Services) {
    this.s = s;
  }

  folders(taskId: string): string[] {
    const rows = all<{ cwd: string }>(this.s.db, "SELECT DISTINCT cwd FROM runs WHERE task_id = ? AND (route_reason IS NULL OR route_reason NOT LIKE 'consult:%') ORDER BY started_at", taskId);
    return rows.map((r) => r.cwd).filter((c) => isAbsolute(c) && existsSync(c));
  }

  /** Files changed in a Jarvis worktree: uncommitted ones plus everything committed on the branch. */
  private async changedInWorktree(dir: string): Promise<Set<string>> {
    const git = async (args: string[]) => (await exec('git', args, { cwd: dir, timeout: 10_000, windowsHide: true }).catch(() => null))?.stdout ?? null;
    const set = new Set<string>();
    const status = await git(['status', '--porcelain', '-uall']);
    for (const line of (status ?? '').split('\n')) if (line.trim()) set.add(line.slice(3).trim().replace(/^"|"$/g, '').split(' -> ').pop()!);
    let base: string | null = null;
    for (const candidate of ['main', 'master', 'trunk', 'develop']) {
      if ((await git(['rev-parse', '--verify', '--quiet', candidate])) !== null) {
        base = candidate;
        break;
      }
    }
    if (base) {
      const diff = await git(['diff', '--name-only', `${base}...HEAD`]);
      for (const f of (diff ?? '').split('\n')) if (f.trim()) set.add(f.trim());
    }
    return set;
  }

  async list(taskId: string): Promise<{ folders: string[]; files: OutputFile[] }> {
    const folders = this.folders(taskId);
    const changedByEvents = new Set(
      all<{ payload_json: string }>(this.s.db, "SELECT payload_json FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE task_id = ?) AND kind = 'file_change'", taskId).map(
        (e) => String((JSON.parse(e.payload_json) as { path?: string }).path ?? '').replace(/\\/g, '/'),
      ),
    );
    const files: OutputFile[] = [];
    for (const [i, dir] of folders.entries()) {
      const worktree = dir.includes('.jarvis-worktrees');
      const names = worktree ? [...(await this.changedInWorktree(dir)), ...[...changedByEvents].filter((p) => !isAbsolute(p))] : walk(dir);
      for (const rel of [...new Set(names)]) {
        const abs = join(dir, rel);
        if (!existsSync(abs)) continue;
        const st = statSync(abs);
        if (!st.isFile()) continue;
        const relEvents = [...changedByEvents].some((p) => p === rel || p.endsWith(`/${rel}`) || (isAbsolute(p) && resolve(p) === resolve(abs)));
        files.push({ folder: i, path: rel, name: basename(rel), size: st.size, mtime: st.mtime.toISOString(), kind: kindOf(rel), changed: worktree || relEvents });
      }
    }
    files.sort((a, b) => Number(b.changed) - Number(a.changed) || b.mtime.localeCompare(a.mtime));
    return { folders, files };
  }

  /** Absolute path of an output, refusing anything outside the task's folders (incl. symlinks out). */
  resolve(taskId: string, folder: number, rel: string): string {
    const folders = this.folders(taskId);
    const root = folders[folder];
    if (!root) throw new Error('not_found');
    const abs = resolve(root, rel);
    const r = relative(root, abs);
    if (!r || r.startsWith('..') || isAbsolute(r)) throw new Error('path is outside the task folder');
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error('not_found');
    const real = realpathSync(abs);
    const realRoot = realpathSync(root);
    const rr = relative(realRoot, real);
    if (rr.startsWith('..') || isAbsolute(rr)) throw new Error('path is outside the task folder');
    return real;
  }

  /** Copy an output into the vault: text through a (self-approved) memory proposal, binaries as files. */
  saveToVault(taskId: string, folder: number, rel: string, targetDir = 'Jarvis/Outputs'): string {
    const mem = this.s.modules.memory as MemoryModule | undefined;
    if (!mem) throw new Error('Memory is not available');
    const abs = this.resolve(taskId, folder, rel);
    const dir = targetDir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || 'Jarvis/Outputs';
    if (dir.startsWith('Skills') || dir.startsWith('.')) throw new Error('Choose a different vault folder.');
    const date = new Date().toISOString().slice(0, 10);
    const name = `${date}-${basename(rel)}`;
    const target = `${dir}/${name}`;
    const kind = kindOf(rel);
    if (kind === 'markdown' || kind === 'text' || kind === 'csv' || kind === 'json' || kind === 'code') {
      const text = readFileSync(abs, 'utf8');
      const mdTarget = kind === 'markdown' ? target : `${target}.md`;
      const body = kind === 'markdown' ? text : `# ${basename(rel)}\n\n\`\`\`${extname(rel).slice(1)}\n${text}\n\`\`\`\n`;
      mem.proposals.propose({ target: mdTarget, content: body, reason: `Saved from task output ${rel}`, mode: 'replace', autoApply: true });
      return mdTarget;
    }
    const dest = mem.vault.resolve(target);
    mkdirSync(join(dest, '..'), { recursive: true });
    copyFileSync(abs, dest);
    return target;
  }
}
