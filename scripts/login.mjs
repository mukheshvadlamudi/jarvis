// One-time plan login for the agents Jarvis uses. Usage: npm run login:claude | npm run login:codex
import { spawnSync } from 'node:child_process';
import { claudeBinary, cleanEnv, codexEntry } from './agent-env.mjs';

const agent = process.argv[2];
if (agent === 'claude') {
  const bin = claudeBinary();
  if (!bin) {
    console.error('Claude Code is not installed for this platform. Run `npm install` first.');
    process.exit(1);
  }
  console.log('\n  Claude Code will open. Type  /login  , choose your Claude subscription (not API key),');
  console.log('  finish in the browser, then type  /exit  to come back.\n');
  const r = spawnSync(bin, [], { stdio: 'inherit', env: cleanEnv() });
  process.exit(r.status ?? 0);
} else if (agent === 'codex') {
  const entry = codexEntry();
  if (!entry) {
    console.error('Codex CLI is not installed. Run `npm install` first.');
    process.exit(1);
  }
  console.log('\n  Signing in to Codex with your ChatGPT account (choose "Sign in with ChatGPT").\n');
  const r = spawnSync(process.execPath, [entry, 'login'], { stdio: 'inherit', env: cleanEnv() });
  process.exit(r.status ?? 0);
} else {
  console.error('usage: node scripts/login.mjs claude|codex');
  process.exit(2);
}
