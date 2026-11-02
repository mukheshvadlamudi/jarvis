import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigStore, DEFAULT_CONFIG, loadEnv, mergeKnown } from '../src/config.ts';
import { sanitizedAgentEnv } from '../src/util/env.ts';
import { capPayload, truncateText } from '../src/util/truncate.ts';

describe('config', () => {
  it('ignores unknown keys and validates updates', () => {
    const store = new ConfigStore(mkdtempSync(join(tmpdir(), 'jcfg-')));
    expect(store.update({ maxConcurrentRuns: 9 })).toMatchObject({ ok: false });
    const ok = store.update({ maxConcurrentRuns: 1, router: { fallbackAtPercent: 80 }, nope: true });
    expect(ok.ok).toBe(true);
    expect(store.get().maxConcurrentRuns).toBe(1);
    expect(store.get().router.defaults.code).toBe('claude');
    expect(mergeKnown(DEFAULT_CONFIG, { router: { defaults: { code: 7 } } }).router.defaults.code).toBe('claude');
    expect(new ConfigStore(dirname(store.file)).get().router.fallbackAtPercent).toBe(80);
  });

  it('binds localhost unless an access token is set', () => {
    expect(loadEnv({ JARVIS_BIND: '0.0.0.0' }).bind).toBe('127.0.0.1');
    expect(loadEnv({ JARVIS_BIND: '0.0.0.0', JARVIS_ACCESS_TOKEN: 'secret' }).bind).toBe('0.0.0.0');
  });
});

describe('agent environment', () => {
  it('strips every API key variable', () => {
    const env = sanitizedAgentEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'a', ANTHROPIC_AUTH_TOKEN: 'b', OPENAI_API_KEY: 'c', CODEX_API_KEY: 'd', HOME: '/h' }, { OPENAI_API_KEY: 'x' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h' });
  });
});

describe('payload caps', () => {
  it('truncates over 20 KB and says so', () => {
    const big = 'x'.repeat(50_000) + 'TAIL';
    const t = truncateText(big);
    expect(t.truncated).toBe(true);
    expect(Buffer.byteLength(t.text)).toBeLessThan(21_000);
    expect(t.text).toContain('truncated by Jarvis');
    expect(t.text.endsWith('TAIL')).toBe(true);
    expect(capPayload({ output: big, n: 1 })).toMatchObject({ truncated: true, n: 1 });
  });
});

describe('agent harness settings', () => {
  it('validates effort levels per agent', () => {
    const store = new ConfigStore(mkdtempSync(join(tmpdir(), 'jcfg-')));
    expect(store.update({ agents: { codex: { effort: { high: 'max' } } } })).toMatchObject({ ok: false });
    expect(store.update({ agents: { claude: { effort: { high: 'max' }, model: 'claude-opus-5-5' } } }).ok).toBe(true);
    expect(store.get().agents.claude.effort.high).toBe('max');
  });
});
