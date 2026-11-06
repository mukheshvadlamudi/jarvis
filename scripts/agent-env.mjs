// Shared helpers for the launcher and login scripts (plain JS so they run before anything is built).
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));
export const BILLING_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'];

/** Environment without API keys, so logins and runs always use the plan accounts. */
export function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (BILLING_KEYS.includes(k.toUpperCase())) delete env[k];
  return env;
}

/** The Claude Code binary that ships with @anthropic-ai/claude-agent-sdk for this platform. */
export function claudeBinary() {
  const names = [`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`, `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}-musl`];
  for (const n of names) {
    try {
      const dir = dirname(require.resolve(`${n}/package.json`));
      for (const bin of ['claude.exe', 'claude']) if (existsSync(join(dir, bin))) return join(dir, bin);
    } catch {
      // not installed for this platform
    }
  }
  return null;
}

/** The Codex CLI entry that ships with @openai/codex (a dependency of @openai/codex-sdk). */
export function codexEntry() {
  try {
    return join(dirname(require.resolve('@openai/codex/package.json')), 'bin', 'codex.js');
  } catch {
    return null;
  }
}

export function loggedIn(agent) {
  const home = homedir();
  if (agent === 'claude') return process.platform === 'darwin' || existsSync(join(home, '.claude', '.credentials.json'));
  return existsSync(join(process.env.CODEX_HOME || join(home, '.codex'), 'auth.json'));
}
