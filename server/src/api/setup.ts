import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import type { Services } from '../app.ts';
import { all, getSetting, run, setSetting } from '../db/index.ts';
import { createClaudeRunner } from '../runners/claude.ts';
import { createCodexRunner } from '../runners/codex.ts';
import type { RunEventSink } from '../runners/types.ts';
import { readLocalEnv, runChecks, scanRepos, suggestCodeRoots, suggestVaults, validateVault, writeLocalEnv } from '../setup/checks.ts';
import { newId, nowIso } from '../util/ids.ts';
import { bad, body } from './core.ts';

export const RESTART_EXIT_CODE = 75;

export function registerSetupRoutes(app: Hono, s: Services): void {
  const localFile = () => join(s.env.dataDir, 'local-env.json');

  app.get('/api/setup', async (c) => {
    const checks = await runChecks(s);
    const required = checks.filter((x) => x.required);
    const done = required.filter((x) => x.state === 'ok').length;
    const pendingRestart = Object.keys(readLocalEnv(localFile())).length > 0 && getSetting<boolean>(s.db, 'setup.pendingRestart', false);
    return c.json({
      checks,
      progress: { done, total: required.length },
      complete: done === required.length,
      dismissed: getSetting<boolean>(s.db, 'setup.dismissed', false),
      runner: s.env.runner,
      platform: process.platform,
      pendingRestart,
      launcher: process.env.JARVIS_LAUNCHER === '1',
      suggestions: { vaults: suggestVaults(), codeRoots: suggestCodeRoots() },
    });
  });

  app.post('/api/setup/dismiss', async (c) => {
    const b = await body<{ dismissed?: boolean }>(c);
    setSetting(s.db, 'setup.dismissed', b.dismissed !== false);
    return c.json({ ok: true });
  });

  app.post('/api/setup/vault', async (c) => {
    const b = await body<{ path?: string; save?: boolean }>(c);
    if (!b.path?.trim()) return bad(c, 'Paste the full path of your Obsidian vault folder.');
    const v = validateVault(b.path);
    if (!v.ok) return c.json(v, 400);
    if (b.save) {
      writeLocalEnv({ JARVIS_VAULT: v.path }, localFile());
      setSetting(s.db, 'setup.pendingRestart', true);
    }
    return c.json({ ...v, saved: !!b.save, restartRequired: !!b.save });
  });

  app.post('/api/setup/scan', async (c) => {
    const b = await body<{ path?: string }>(c);
    if (!b.path?.trim()) return bad(c, 'Paste a folder that contains your git repositories.');
    const registered = new Set(all<{ path: string }>(s.db, "SELECT path FROM projects WHERE path IS NOT NULL").map((r) => r.path));
    return c.json({ repos: scanRepos(b.path, registered) });
  });

  app.post('/api/setup/projects', async (c) => {
    const b = await body<{ repos?: Array<{ name: string; path: string }> }>(c);
    const existing = new Set(all<{ path: string }>(s.db, 'SELECT path FROM projects WHERE path IS NOT NULL').map((r) => r.path));
    let added = 0;
    for (const r of b.repos ?? []) {
      if (!r.path || existing.has(r.path)) continue;
      run(s.db, 'INSERT INTO projects (id, name, kind, path, created_at) VALUES (?, ?, ?, ?, ?)', newId('p'), r.name || r.path, 'code', r.path, nowIso());
      added++;
    }
    s.bus.publish('project.created', { added });
    return c.json({ added });
  });

  app.post('/api/setup/telegram', async (c) => {
    const b = await body<{ token?: string; chatId?: string }>(c);
    if (!b.token?.trim() || !/^\d+:[\w-]{20,}$/.test(b.token.trim())) return bad(c, 'That does not look like a bot token from @BotFather (digits:letters).');
    if (!b.chatId?.trim() || !/^-?\d+$/.test(b.chatId.trim())) return bad(c, 'The chat id is a number — message @userinfobot on Telegram to get yours.');
    writeLocalEnv({ TELEGRAM_BOT_TOKEN: b.token.trim(), TELEGRAM_ALLOWED_CHAT_ID: b.chatId.trim() }, localFile());
    setSetting(s.db, 'setup.pendingRestart', true);
    return c.json({ saved: true, restartRequired: true });
  });

  app.post('/api/setup/verify/:agent', async (c) => {
    const agent = c.req.param('agent');
    if (agent !== 'claude' && agent !== 'codex') return bad(c, 'agent must be claude or codex', 404);
    if (s.env.runner === 'mock') return bad(c, 'Jarvis is in mock mode, so it never calls a real agent. Set JARVIS_RUNNER=real in .env and restart to verify your login.', 409);
    const cwd = mkdtempSync(join(tmpdir(), 'jarvis-verify-'));
    const events: string[] = [];
    const sink: RunEventSink = {
      emit: (e) => e.kind === 'error' && events.push(String(e.payload.message)),
      setSessionId: () => undefined,
      requestApproval: async () => ({ approved: false, status: 'rejected' }),
      rateLimit: (r) => s.usage.recordReading(r),
    };
    const runner = agent === 'claude' ? createClaudeRunner() : createCodexRunner();
    const handle = runner.start({ taskId: 'verify', runId: 'verify', prompt: 'Reply with exactly the word "ready" and nothing else. Do not use tools.', contextPrefix: '', cwd, sandbox: 'read-only', allowNetwork: false, taskType: 'other' }, sink);
    const timer = setTimeout(() => void handle.cancel(), 90_000);
    const r = await handle.done;
    clearTimeout(timer);
    rmSync(cwd, { recursive: true, force: true });
    if (r.status !== 'done') {
      return c.json({ ok: false, message: r.error ?? events[0] ?? 'The agent did not answer. Log in again and retry.', hint: agent === 'claude' ? 'npm run login:claude' : 'npm run login:codex' }, 400);
    }
    setSetting(s.db, `setup.verified.${agent}`, nowIso());
    return c.json({ ok: true, reply: r.summary.slice(0, 200), tokens: r.usage.inputTokens + r.usage.outputTokens });
  });

  app.post('/api/setup/restart', (c) => {
    if (process.env.JARVIS_LAUNCHER !== '1') {
      return bad(c, 'Jarvis was not started by the launcher, so it cannot restart itself. Stop it and start it again (start-jarvis).', 409);
    }
    setSetting(s.db, 'setup.pendingRestart', false);
    const shutdown = s.modules.requestShutdown as ((code: number) => void) | undefined;
    setTimeout(() => (shutdown ? shutdown(RESTART_EXIT_CODE) : process.exit(RESTART_EXIT_CODE)), 300).unref();
    return c.json({ restarting: true });
  });
}
