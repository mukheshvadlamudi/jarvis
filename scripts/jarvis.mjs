// One-click launcher: checks prerequisites, installs and builds on first run, offers the one-time
// agent logins, starts Jarvis, opens it in the browser, and restarts it when Setup asks to.
//   Windows: double-click start-jarvis.cmd   macOS: start-jarvis.command   Linux: ./start-jarvis.sh
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { ROOT, loggedIn } from './agent-env.mjs';

const args = new Set(process.argv.slice(2));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const say = (m = '') => console.log(`  ${m}`);

function newestMtime(dir) {
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return t;
}

function run(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    say(`\n  "${cmd} ${cmdArgs.join(' ')}" failed. Fix the error above and start Jarvis again.`);
    process.exit(r.status ?? 1);
  }
}

async function ask(q) {
  if (!process.stdin.isTTY || args.has('--yes')) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`  ${q} [Y/n] `)).trim().toLowerCase();
  rl.close();
  return a === '' || a === 'y' || a === 'yes';
}

function envValue(key) {
  if (process.env[key]) return process.env[key];
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return undefined;
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(file, 'utf8'));
  return m?.[1]?.trim() || undefined;
}

function openBrowser(url) {
  if (args.has('--no-open')) return;
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // no browser available (headless machine)
  }
}

console.log('\n  J A R V I S\n');
const major = Number(process.versions.node.split('.')[0]);
if (major < 24) {
  say(`Node ${process.versions.node} found — Jarvis needs Node 24 or newer.`);
  say('Install the LTS from https://nodejs.org (Windows: winget install OpenJS.NodeJS.LTS) and run this again.');
  process.exit(1);
}
if (!existsSync(join(ROOT, 'node_modules'))) {
  say('First run: installing dependencies (one time, a minute or two)…');
  run(npm, ['install', '--no-fund', '--no-audit']);
}
if (!existsSync(join(ROOT, '.env'))) {
  copyFileSync(join(ROOT, '.env.example'), join(ROOT, '.env'));
  const real = readFileSync(join(ROOT, '.env'), 'utf8').replace(/^JARVIS_RUNNER=.*$/m, `JARVIS_RUNNER=${args.has('--demo') ? 'mock' : 'real'}`);
  writeFileSync(join(ROOT, '.env'), real);
  say('Created .env (edit it any time; the Setup page covers the common settings).');
}
const dist = join(ROOT, 'web', 'dist', 'index.html');
if (!existsSync(dist) || statSync(dist).mtimeMs < newestMtime(join(ROOT, 'web', 'src'))) {
  say('Building the interface…');
  run(npm, ['run', 'build', '-w', 'web']);
}

const mode = args.has('--demo') ? 'mock' : envValue('JARVIS_RUNNER') ?? 'real';
if (mode === 'real') {
  for (const agent of ['claude', 'codex']) {
    if (loggedIn(agent)) continue;
    const label = agent === 'claude' ? 'Claude (your Claude Pro/Max plan)' : 'Codex (your ChatGPT Plus/Pro plan)';
    if (await ask(`No ${label} login found. Log in now?`)) run(process.execPath, [join(ROOT, 'scripts', 'login.mjs'), agent]);
    else say(`Skipped. You can log in later with: npm run login:${agent}`);
  }
}

const port = envValue('JARVIS_PORT') ?? '4317';
const url = `http://127.0.0.1:${port}`;
let opened = false;

// Double-clicking again while Jarvis runs should just bring it up, not crash on a busy port.
const running = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) })
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null);
if (running?.ok) {
  say(`Jarvis is already running at ${url} (${running.runner} mode). Opening it.`);
  openBrowser(url);
  process.exit(0);
}
const busy = await new Promise((done) => {
  const probe = createServer().once('error', () => done(true)).once('listening', () => probe.close(() => done(false)));
  probe.listen(Number(port), '127.0.0.1');
});
if (busy) {
  say(`Port ${port} is in use by another program, so Jarvis can't start.`);
  say(`Close that program, or set JARVIS_PORT to a free port in .env, then start Jarvis again.`);
  process.exit(1);
}

function start() {
  const env = { ...process.env, JARVIS_LAUNCHER: '1', ...(args.has('--demo') ? { JARVIS_RUNNER: 'mock' } : {}) };
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', join('server', 'src', 'index.ts')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.on('data', (d) => {
    process.stdout.write(d);
    if (!opened && String(d).includes('Jarvis on http')) {
      opened = true;
      say(`\n  Open ${url}  ·  Ctrl+C to stop\n`);
      openBrowser(url);
    }
  });
  child.on('exit', (code) => {
    if (code === 75) {
      say('Restarting with the new settings…');
      start();
    } else {
      process.exit(code ?? 0);
    }
  });
  const stop = () => child.kill('SIGINT');
  process.removeAllListeners('SIGINT');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
start();
