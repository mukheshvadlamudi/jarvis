// Pure helpers for the Electron main process (unit-tested without Electron).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const BILLING_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'];

/** Minimal .env reader: KEY=VALUE lines, # comments, optional quotes. */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v !== '') out[m[1]] = v;
  }
  return out;
}

export function readEnvFile(path) {
  return existsSync(path) ? parseEnvFile(readFileSync(path, 'utf8')) : {};
}

/** Environment for the server child: no API keys, Electron acting as plain Node. */
export function serverEnv(base, extra) {
  const env = { ...base, ...extra, ELECTRON_RUN_AS_NODE: '1' };
  for (const k of BILLING_KEYS) delete env[k];
  return env;
}

/** Paths for dev (run from the repo) vs. packaged (resources/jarvis + per-user data dir). */
export function layout({ isPackaged, resourcesPath, appDir, userData }) {
  const root = isPackaged ? join(resourcesPath, 'jarvis') : join(appDir, '..');
  return {
    root,
    serverEntry: join(root, 'server', 'src', 'index.ts'),
    dataDir: isPackaged ? join(userData, 'data') : join(root, 'data'),
    envFile: isPackaged ? join(userData, '.env') : join(root, '.env'),
    logFile: join(isPackaged ? userData : join(root, 'data'), 'logs', 'server.log'),
  };
}

/** Command that opens a terminal window running the agent's one-time login. */
export function loginTerminalCommand(platform, { exe, args, env = {} }) {
  const q = (s) => `"${s}"`;
  const line = [q(exe), ...args.map(q)].join(' ');
  const sets = Object.entries(env);
  if (platform === 'win32') {
    const prefix = sets.map(([k, v]) => `set ${k}=${v}&& `).join('');
    return { cmd: 'cmd.exe', args: ['/c', 'start', '"Jarvis login"', 'cmd.exe', '/k', `${prefix}${line}`] };
  }
  const exports = sets.map(([k, v]) => `export ${k}=${v}; `).join('');
  if (platform === 'darwin') {
    const script = `${exports}${line}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return { cmd: 'osascript', args: ['-e', `tell application "Terminal" to do script "${script}"`, '-e', 'tell application "Terminal" to activate'] };
  }
  return { cmd: 'x-terminal-emulator', args: ['-e', 'sh', '-c', `${exports}${line}; echo; echo "You can close this window."; read _`] };
}

/** Parse a chunk of an SSE stream; returns complete events and the leftover buffer. */
export function parseSse(buffer) {
  const events = [];
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  for (const p of parts) {
    let type = 'message';
    const data = [];
    for (const line of p.split('\n')) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) continue;
    try {
      events.push({ type, data: JSON.parse(data.join('\n')) });
    } catch {
      events.push({ type, data: data.join('\n') });
    }
  }
  return { events, rest };
}
