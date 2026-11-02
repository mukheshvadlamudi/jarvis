import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layout, loginTerminalCommand, parseEnvFile, parseSse, serverEnv } from '../lib.mjs';

test('parses .env files', () => {
  assert.deepEqual(parseEnvFile('# c\nA=1\nB="two words"\nEMPTY=\n bad line\nC=\'x\''), { A: '1', B: 'two words', C: 'x' });
});

test('server env strips API keys and runs Electron as Node', () => {
  const env = serverEnv({ PATH: '/bin', OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' }, { JARVIS_PORT: '4317' });
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.JARVIS_PORT, '4317');
});

test('layout differs for packaged and dev', () => {
  const dev = layout({ isPackaged: false, resourcesPath: '/r', appDir: '/repo/desktop', userData: '/u' });
  assert.equal(dev.root, '/repo');
  assert.equal(dev.dataDir, '/repo/data');
  const pkg = layout({ isPackaged: true, resourcesPath: '/r', appDir: '/x', userData: '/u' });
  assert.equal(pkg.serverEntry, '/r/jarvis/server/src/index.ts');
  assert.equal(pkg.dataDir, '/u/data');
  assert.equal(pkg.envFile, '/u/.env');
});

test('login terminal commands per platform', () => {
  const win = loginTerminalCommand('win32', { exe: 'C:\\J\\Jarvis.exe', args: ['C:\\J\\codex.js', 'login'], env: { ELECTRON_RUN_AS_NODE: '1' } });
  assert.equal(win.cmd, 'cmd.exe');
  assert.match(win.args.at(-1), /^set ELECTRON_RUN_AS_NODE=1&& "C:\\J\\Jarvis.exe" "C:\\J\\codex.js" "login"$/);
  assert.equal(loginTerminalCommand('darwin', { exe: '/a/claude', args: [] }).cmd, 'osascript');
  assert.equal(loginTerminalCommand('linux', { exe: '/a/claude', args: [] }).cmd, 'x-terminal-emulator');
});

test('parses SSE chunks across boundaries', () => {
  const a = parseSse('event: approval.created\ndata: {"id":"a_1"}\n\nevent: ping\nda');
  assert.deepEqual(a.events, [{ type: 'approval.created', data: { id: 'a_1' } }]);
  const b = parseSse(`${a.rest}ta: {}\n\n`);
  assert.deepEqual(b.events, [{ type: 'ping', data: {} }]);
});
