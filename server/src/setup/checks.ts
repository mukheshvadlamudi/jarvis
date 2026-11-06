import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Services } from '../app.ts';
import { all, get, getSetting } from '../db/index.ts';
import { REPO_ROOT } from '../config.ts';
import { presentBillingKeys } from '../util/env.ts';

const exec = promisify(execFile);

/** The login command, runnable from any folder (npm needs the Jarvis folder to find its scripts). */
export function loginCommand(agent: 'claude' | 'codex'): string {
  const cd = process.platform === 'win32' ? `cd /d "${REPO_ROOT}"` : `cd "${REPO_ROOT}"`;
  return `${cd} && npm run login:${agent}`;
}

export type CheckState = 'ok' | 'todo' | 'warn' | 'optional';

export interface Check {
  id: string;
  title: string;
  state: CheckState;
  detail: string;
  required: boolean;
  /** Command(s) the owner can copy to fix it. */
  fix?: string[];
  action?: 'vault' | 'projects' | 'verify-claude' | 'verify-codex' | 'skills' | 'routines' | 'telegram' | 'restart';
}

async function version(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec(cmd, args, { timeout: 8000, windowsHide: true });
    return stdout.trim().split('\n')[0];
  } catch {
    return null;
  }
}

/** Local overrides chosen in the Setup page (read by loadEnv on the next start). */
export const LOCAL_ENV_FILE = () => join(REPO_ROOT, 'data', 'local-env.json');

export function readLocalEnv(file = LOCAL_ENV_FILE()): Record<string, string> {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

export function writeLocalEnv(patch: Record<string, string>, file = LOCAL_ENV_FILE()): Record<string, string> {
  const next = { ...readLocalEnv(file), ...patch };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

export async function runChecks(s: Services): Promise<Check[]> {
  const home = homedir();
  const checks: Check[] = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({
    id: 'node', title: 'Node.js 24', required: true,
    state: nodeMajor >= 24 ? 'ok' : 'todo',
    detail: nodeMajor >= 24 ? `Running Node ${process.versions.node}.` : `Running Node ${process.versions.node}; Jarvis needs 24 or newer.`,
    fix: nodeMajor >= 24 ? undefined : ['Install the LTS from https://nodejs.org (or: winget install OpenJS.NodeJS.LTS)'],
  });

  const git = await version('git', ['--version']);
  checks.push({
    id: 'git', title: 'Git', required: true, state: git ? 'ok' : 'todo',
    detail: git ?? 'Not found. Coding tasks need git for worktrees.',
    fix: git ? undefined : ['winget install Git.Git'],
  });

  const keys = presentBillingKeys();
  checks.push({
    id: 'keys', title: 'No API keys in use', required: true, state: keys.length ? 'warn' : 'ok',
    detail: keys.length ? `${keys.join(', ')} found in the environment — Jarvis strips them from agents, but remove them from your profile to be safe.` : 'Agents always bill your Claude and ChatGPT plans.',
  });

  const claudeLogin = !s.env.demo && (existsSync(join(home, '.claude', '.credentials.json')) || process.platform === 'darwin');
  const claudeVerified = getSetting<string | null>(s.db, 'setup.verified.claude', null);
  checks.push({
    id: 'claude', title: 'Claude Code login (Claude Pro/Max)', required: true,
    state: claudeVerified ? 'ok' : claudeLogin ? 'warn' : 'todo',
    detail: claudeVerified
      ? `Verified ${new Date(claudeVerified).toLocaleDateString()} with a tiny run.`
      : claudeLogin
        ? 'A saved login was found. Verify it with one tiny run.'
        : 'Log in once with your Claude plan. Jarvis ships the Claude Code CLI — no global install needed.',
    fix: claudeVerified ? undefined : [loginCommand('claude'), '(then type /login, finish in the browser, and /exit)'],
    action: 'verify-claude',
  });

  let chromeCheck: { ok?: boolean; checkedAt?: string } = {};
  try { chromeCheck = JSON.parse(readFileSync(join(s.env.dataDir, 'chrome-check.json'), 'utf8')); } catch { /* not verified yet */ }
  const chrome = s.config.get().agents.claude.chrome;
  checks.push({
    id: 'claude-chrome', title: 'Install Claude in Chrome', required: false,
    state: chrome && chromeCheck.ok ? 'ok' : chrome && chromeCheck.checkedAt ? 'warn' : 'optional',
    detail: !chrome ? 'Optional: install and connect the extension, enable Chrome in Settings → Agents, then verify startup here.'
      : chromeCheck.ok ? `A run with --chrome completed cleanly (${chromeCheck.checkedAt}). This checks startup, not the extension connection; check /chrome in Claude Code.`
      : chromeCheck.checkedAt ? 'The last --chrome verification did not finish cleanly. Check your Claude login and extension, then retry.'
      : 'Chrome is enabled. Verify that a run with --chrome starts cleanly. You approve sites in the extension; outward actions still need Jarvis approval.',
  });

  const codexHome = process.env.CODEX_HOME || join(home, '.codex');
  const codexLogin = !s.env.demo && existsSync(join(codexHome, 'auth.json'));
  const codexVerified = getSetting<string | null>(s.db, 'setup.verified.codex', null);
  checks.push({
    id: 'codex', title: 'Codex login (ChatGPT Plus/Pro)', required: true,
    state: codexVerified ? 'ok' : codexLogin ? 'warn' : 'todo',
    detail: codexVerified ? `Verified ${new Date(codexVerified).toLocaleDateString()} with a tiny run.` : codexLogin ? 'A saved login was found. Verify it with one tiny run.' : 'Sign in with ChatGPT once. Jarvis ships the Codex CLI.',
    fix: codexVerified ? undefined : [loginCommand('codex')],
    action: 'verify-codex',
  });

  const vaultOk = existsSync(s.env.vault) && statSync(s.env.vault).isDirectory();
  const notes = get<{ n: number }>(s.db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'notes_index'")?.n ? get<{ n: number }>(s.db, 'SELECT COUNT(*) AS n FROM notes_index')?.n ?? 0 : 0;
  checks.push({
    id: 'vault', title: 'Obsidian vault', required: true,
    state: s.env.vaultSource ? 'todo' : vaultOk && notes > 0 ? 'ok' : 'todo',
    detail: s.env.vaultSource ? 'Using the demo vault. Point Jarvis at your own Obsidian vault folder.' : vaultOk ? `${notes} notes indexed in ${s.env.vault}.` : `Folder not found: ${s.env.vault}`,
    action: 'vault',
  });

  const projects = all<{ path: string | null }>(s.db, "SELECT path FROM projects WHERE kind = 'code'");
  const withPath = projects.filter((p) => p.path && existsSync(p.path)).length;
  checks.push({
    id: 'projects', title: 'Code projects', required: false,
    state: withPath ? 'ok' : 'optional',
    detail: withPath ? `${withPath} repo${withPath === 1 ? '' : 's'} connected — coding tasks run in their own git worktrees.` : 'Connect the folders that hold your git repos.',
    action: 'projects',
  });

  const gh = await version('gh', ['--version']);
  let ghAuth = false;
  if (gh) {
    try {
      await exec('gh', ['auth', 'status'], { timeout: 8000, windowsHide: true });
      ghAuth = true;
    } catch {
      ghAuth = false;
    }
  }
  checks.push({
    id: 'gh', title: 'GitHub CLI (for “Open PR”)', required: false,
    state: ghAuth ? 'ok' : 'optional',
    detail: ghAuth ? 'Logged in. PRs still need your approval each time.' : gh ? 'Installed but not logged in.' : 'Optional — needed only to open pull requests from Jarvis.',
    fix: ghAuth ? undefined : gh ? ['gh auth login'] : ['winget install GitHub.cli', 'gh auth login'],
  });

  const synced = get<{ n: number }>(s.db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'skills'")?.n ? get<{ n: number }>(s.db, 'SELECT COUNT(*) AS n FROM skills WHERE synced_at IS NOT NULL')?.n ?? 0 : 0;
  checks.push({
    id: 'skills', title: 'Skills synced to Claude and Codex', required: false, state: synced ? 'ok' : 'optional',
    detail: synced ? `${synced} skill${synced === 1 ? '' : 's'} synced.` : 'Copy your vault skills into both agents.', action: 'skills',
  });

  const routines = get<{ n: number }>(s.db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'schedules'")?.n ? get<{ n: number }>(s.db, 'SELECT COUNT(*) AS n FROM schedules WHERE enabled = 1')?.n ?? 0 : 0;
  checks.push({
    id: 'routines', title: 'Morning brief and routines', required: false, state: routines ? 'ok' : 'optional',
    detail: routines ? `${routines} routine${routines === 1 ? '' : 's'} on.` : 'All routines start off. Turn on the ones you want.', action: 'routines',
  });

  checks.push({
    id: 'telegram', title: 'Telegram (phone)', required: false,
    state: s.env.telegramToken && s.env.telegramChatId ? 'ok' : 'optional',
    detail: s.env.telegramToken && s.env.telegramChatId ? 'Bot configured.' : 'Optional — approve and capture from your phone. Add the bot token and your chat id.',
    action: 'telegram',
  });
  return checks;
}

/** Folders that look like Obsidian vaults (contain .obsidian) near the usual places. */
export function suggestVaults(home = homedir()): string[] {
  const roots = [home, join(home, 'Documents'), join(home, 'OneDrive', 'Documents'), join(home, 'iCloudDrive'), join(home, 'Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents')];
  const out = new Set<string>();
  for (const r of roots) {
    let entries: string[] = [];
    try {
      entries = readdirSync(r);
    } catch {
      continue;
    }
    if (existsSync(join(r, '.obsidian'))) out.add(r);
    for (const e of entries.slice(0, 200)) {
      if (e.startsWith('.')) continue;
      const p = join(r, e);
      try {
        if (statSync(p).isDirectory() && existsSync(join(p, '.obsidian'))) out.add(p);
      } catch {
        // unreadable folder
      }
    }
  }
  return [...out].slice(0, 12);
}

export function suggestCodeRoots(home = homedir()): string[] {
  return ['code', 'Code', 'projects', 'Projects', 'dev', 'src', 'repos', join('source', 'repos'), join('Documents', 'GitHub'), join('Documents', 'code'), 'GitHub']
    .map((p) => join(home, p))
    .filter((p) => existsSync(p) && statSync(p).isDirectory());
}

export function validateVault(path: string): { ok: boolean; path: string; notes: number; obsidian: boolean; error?: string } {
  const abs = resolve(path.trim());
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return { ok: false, path: abs, notes: 0, obsidian: false, error: 'That folder does not exist on this computer.' };
  let notes = 0;
  const walk = (dir: string, depth: number) => {
    if (notes > 5000 || depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) walk(join(dir, e.name), depth + 1);
      else if (e.name.toLowerCase().endsWith('.md')) notes++;
    }
  };
  walk(abs, 0);
  return { ok: true, path: abs, notes, obsidian: existsSync(join(abs, '.obsidian')) };
}

/** Git repositories under a folder (2 levels deep), skipping dependency and worktree folders. */
export function scanRepos(root: string, registered: Set<string>): Array<{ name: string; path: string; registered: boolean }> {
  const abs = resolve(root.trim());
  const out: Array<{ name: string; path: string; registered: boolean }> = [];
  const visit = (dir: string, depth: number) => {
    if (out.length >= 100) return;
    if (existsSync(join(dir, '.git'))) {
      out.push({ name: basename(dir), path: dir, registered: registered.has(dir) });
      return;
    }
    if (depth >= 2) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules' || e.name === '.jarvis-worktrees') continue;
      visit(join(dir, e.name), depth + 1);
    }
  };
  if (existsSync(abs)) visit(abs, 0);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
