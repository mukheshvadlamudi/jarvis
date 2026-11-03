import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { layout, loginTerminalCommand, parseEnvFile, parseSse, serverEnv, registerAnywhereShortcut, pasteWithClipboard } from '../lib.mjs';

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
  const dev = layout({ isPackaged: false, resourcesPath: '/r', appDir: join('/repo', 'desktop'), userData: '/u' });
  assert.equal(dev.root, join('/repo'));
  assert.equal(dev.dataDir, join('/repo', 'data'));
  const pkg = layout({ isPackaged: true, resourcesPath: '/r', appDir: '/x', userData: '/u' });
  assert.equal(pkg.serverEntry, join('/r', 'jarvis', 'server', 'src', 'index.ts'));
  assert.equal(pkg.dataDir, join('/u', 'data'));
  assert.equal(pkg.envFile, join('/u', '.env'));
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

test('anywhere shortcut checks registration and reports fallback or complete failure', () => {
  const calls = [];
  const register = (key) => { calls.push(key); return key === 'Control+Alt+Space'; };
  const result = registerAnywhereShortcut(register, 'Control+Space', () => {});
  assert.deepEqual(calls, ['Control+Space', 'Control+Alt+Space']);
  assert.equal(result.shortcut, 'Control+Alt+Space');
  assert.match(result.warning, /unavailable/);
  assert.equal(registerAnywhereShortcut(() => true, 'Control+Space', () => {}).warning, '');
  assert.equal(registerAnywhereShortcut(() => { throw Error('invalid'); }, 'bad', () => {}).shortcut, null);
});

test('clipboard saves before writing, restores focus before pasting, and restores after one second', async () => {
  const calls = [];
  await pasteWithClipboard('dictation', {
    save: () => { calls.push('save'); return ['old formats']; },
    write: (text) => calls.push(['write', text]),
    restoreFocus: () => calls.push('focus'),
    paste: () => calls.push('paste'),
    delay: (ms) => calls.push(['delay', ms]),
    unchanged: () => true,
    restore: (old) => calls.push(['restore', old]),
  });
  assert.deepEqual(calls, ['save', ['write', 'dictation'], 'focus', 'paste', ['delay', 1000], ['restore', ['old formats']]]);
});

test('clipboard is restored on focus failure and a newer copy is preserved', async () => {
  let pasted = false;
  let restored = false;
  const deps = { save: () => 'old', write: () => {}, restoreFocus: () => { throw Error('focus'); }, paste: () => { pasted = true; }, delay: () => {}, unchanged: () => true, restore: () => { restored = true; } };
  await assert.rejects(pasteWithClipboard('new', deps), /focus/);
  assert.equal(pasted, false);
  assert.equal(restored, true);
  restored = false;
  await pasteWithClipboard('new', { ...deps, restoreFocus: () => {}, unchanged: () => false });
  assert.equal(restored, false);
});
