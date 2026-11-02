import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { decide } from '../src/router/index.ts';
import type { UsageState } from '../src/types.ts';

const cfg = DEFAULT_CONFIG.router;
const w = (usedPercent: number, resetsAt: string | null = '2026-11-02T12:00:00.000Z') => ({ usedPercent, resetsAt, source: 'test', estimate: false, tokens: null, ts: '2026-11-02T08:00:00.000Z' });
const usage = (c5: number, cw: number, x5: number, xw: number): UsageState => ({
  claude: { five_hour: w(c5), weekly: w(cw, '2026-11-05T00:00:00.000Z') },
  codex: { five_hour: w(x5, '2026-11-02T10:00:00.000Z'), weekly: w(xw, '2026-11-06T00:00:00.000Z') },
});
const base = { agent_pref: 'auto' as const, schedule_id: null, effort: 'medium' as const, type: 'code' as const, outward: 0 };
const idle = usage(10, 10, 10, 10);

describe('router', () => {
  it('follows rule order: explicit → scheduled → effort → type', () => {
    expect(decide({ ...base, agent_pref: 'codex' }, idle, cfg)).toMatchObject({ agent: 'codex', reason: 'you chose codex' });
    expect(decide({ ...base, schedule_id: 's1' }, idle, cfg).agent).toBe('codex');
    expect(decide({ ...base, type: 'research', effort: 'high' }, idle, cfg)).toMatchObject({ agent: 'claude', reason: 'high effort → claude' });
    expect(decide({ ...base, type: 'research' }, idle, cfg)).toMatchObject({ agent: 'codex', reason: 'research → codex' });
    expect(decide(base, idle, cfg)).toMatchObject({ agent: 'claude', reason: 'code → claude' });
  });

  it('sends outward tasks to Claude for per-tool approvals', () => {
    expect(decide({ ...base, type: 'admin', outward: 1 }, idle, cfg).agent).toBe('claude');
  });

  it('falls back when the chosen agent is over the threshold', () => {
    const d = decide(base, usage(91, 20, 30, 20), cfg);
    expect(d).toEqual({ agent: 'codex', reason: 'fallback: claude 5h at 91%' });
    expect(decide({ ...base, type: 'research' }, usage(10, 10, 20, 88), cfg).reason).toBe('fallback: codex weekly at 88%');
  });

  it('holds until the earliest reset when both agents are exhausted', () => {
    const d = decide(base, usage(95, 50, 90, 50), cfg);
    expect(d.holdUntil).toBe('2026-11-02T10:00:00.000Z');
    expect(d.reason).toMatch(/both agents over 85%/);
  });

  it('respects an explicit choice by waiting instead of switching', () => {
    const d = decide({ ...base, agent_pref: 'claude' }, usage(92, 10, 10, 10), cfg);
    expect(d.agent).toBe('claude');
    expect(d.holdUntil).toBe('2026-11-02T12:00:00.000Z');
  });
});
