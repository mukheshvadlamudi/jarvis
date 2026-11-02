/**
 * One tiny real run against your plan login. Run locally only:
 *   npm run smoke:claude
 *   npm run smoke:codex
 * It never uses API keys (they are stripped from the agent environment) and refuses to run in CI.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeRunner } from '../src/runners/claude.ts';
import { createCodexRunner } from '../src/runners/codex.ts';
import type { RunEventSink } from '../src/runners/types.ts';
import { presentBillingKeys } from '../src/util/env.ts';

const agent = process.argv[2];
if (agent !== 'claude' && agent !== 'codex') {
  console.error('usage: node scripts/smoke.ts claude|codex');
  process.exit(2);
}
if (process.env.CI || process.env.JARVIS_RUNNER === 'mock' || process.env.CLAUDE_CODE_REMOTE) {
  console.error('Refusing to run: smoke tests make a real agent call and are for your own machine only.');
  process.exit(2);
}
const loginFile = agent === 'claude' ? join(homedir(), '.claude', '.credentials.json') : join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
if (!existsSync(loginFile)) {
  console.warn(`No saved login found at ${loginFile}. Log in first: ${agent === 'claude' ? '`claude` then /login' : '`codex login`'}. (On macOS Claude may use the Keychain instead; continuing.)`);
}
const keys = presentBillingKeys();
if (keys.length) console.warn(`Note: ${keys.join(', ')} set in your shell; they are removed from the agent environment.`);

const cwd = mkdtempSync(join(tmpdir(), 'jarvis-smoke-'));
const sink: RunEventSink = {
  emit: (e) => console.log(`  ${e.kind.padEnd(11)} ${JSON.stringify(e.payload).slice(0, 160)}`),
  setSessionId: (id) => console.log(`  session     ${id}`),
  requestApproval: async (r) => {
    console.log(`  approval?   ${r.summary} — auto-rejected in smoke test`);
    return { approved: false, status: 'rejected', note: 'smoke test' };
  },
  rateLimit: (r) => console.log(`  plan usage  ${r.window} ${r.usedPercent.toFixed(1)}% resets ${r.resetsAt ?? '?'}`),
};

const runner = agent === 'claude' ? createClaudeRunner() : createCodexRunner();
console.log(`Smoke test: ${agent} in ${cwd}`);
const started = Date.now();
const handle = runner.start(
  {
    taskId: 'smoke',
    runId: 'smoke',
    prompt: 'Reply with exactly the word "pong" and nothing else. Do not use any tools.',
    contextPrefix: 'This is a connectivity check from Jarvis.',
    cwd,
    sandbox: 'read-only',
    allowNetwork: false,
    taskType: 'other',
  },
  sink,
);
const timer = setTimeout(() => {
  console.error('Timed out after 120 s; cancelling.');
  void handle.cancel();
}, 120_000);
const result = await handle.done;
clearTimeout(timer);
rmSync(cwd, { recursive: true, force: true });
console.log(`\nResult: ${result.status} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
console.log(`Summary: ${result.summary}`);
console.log(`Tokens: in ${result.usage.inputTokens}, out ${result.usage.outputTokens}, cached ${result.usage.cachedTokens}`);
process.exit(result.status === 'done' ? 0 : 1);
