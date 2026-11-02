import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCodexLine } from '../src/usage/meter.ts';
import { REPO, makeCtx } from './helpers.ts';
import type { TestCtx } from './helpers.ts';

const codexHome = join(REPO, 'fixtures/usage/codex');
const claudeHome = join(REPO, 'fixtures/usage/claude');
let ctx: TestCtx;
afterEach(async () => ctx?.close());

describe('usage parsers', () => {
  it('reads Codex rate_limits in both historic shapes', () => {
    const relative = parseCodexLine({ timestamp: '2026-10-30T14:02:51.412Z', type: 'event_msg', payload: { type: 'token_count', info: {}, rate_limits: { primary: { used_percent: 31, window_minutes: 300, resets_in_seconds: 3600 }, secondary: { used_percent: 12, window_minutes: 10080, resets_in_seconds: 7200 } } } });
    expect(relative?.windows).toEqual([
      { window: 'five_hour', usedPercent: 31, resetsAt: '2026-10-30T15:02:51.412Z' },
      { window: 'weekly', usedPercent: 12, resetsAt: '2026-10-30T16:02:51.412Z' },
    ]);
    const absolute = parseCodexLine({ timestamp: '2026-11-01T09:17:02.088Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 8, window_minutes: 300, resets_at: 1762004102 } } } });
    expect(absolute?.windows[0].resetsAt).toBe(new Date(1762004102 * 1000).toISOString());
    expect(parseCodexLine({ type: 'event_msg', payload: { type: 'agent_message' } })).toBeNull();
  });

});

describe('usage meter on fixture logs', () => {
  it('takes the newest Codex snapshot and never guesses Claude from transcripts', () => {
    ctx = makeCtx({ env: { JARVIS_CODEX_HOME: codexHome, JARVIS_CLAUDE_HOME: claudeHome } });
    const now = Date.parse('2026-11-01T10:00:00.000Z');
    ctx.s.usage.poll(now);
    const cur = ctx.s.usage.current(now);
    expect(cur.codex.five_hour).toMatchObject({ usedPercent: 27.5, source: 'codex-session-log', estimate: false });
    expect(cur.codex.weekly?.usedPercent).toBe(26);
    // Claude transcripts are on disk, but token totals are not the plan's limits: unknown until Claude reports.
    expect(cur.claude.five_hour).toBeNull();
    expect(cur.claude.weekly).toBeNull();
    // Re-polling unchanged files reads nothing new and adds no rows.
    const before = ctx.s.db.prepare('SELECT COUNT(*) AS n FROM usage_snapshots').get() as { n: number };
    ctx.s.usage.poll(now);
    const after = ctx.s.db.prepare('SELECT COUNT(*) AS n FROM usage_snapshots').get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('ignores old estimate rows', () => {
    ctx = makeCtx();
    ctx.s.db.prepare("INSERT INTO usage_snapshots (ts, agent, window, used_percent, tokens, resets_at, source) VALUES (?, 'claude', 'five_hour', 97, 1, ?, 'estimate')").run(new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString());
    expect(ctx.s.usage.current().claude.five_hour).toBeNull();
    ctx.s.usage.recordReading({ agent: 'claude', window: 'five_hour', usedPercent: 69, resetsAt: new Date(Date.now() + 3600_000).toISOString(), source: 'claude-usage' });
    expect(ctx.s.usage.current().claude.five_hour).toMatchObject({ usedPercent: 69, source: 'claude-usage' });
  });

  it('treats a window whose reset has passed as 0% and prefers live SDK readings', () => {
    ctx = makeCtx({ env: { JARVIS_CODEX_HOME: codexHome, JARVIS_CLAUDE_HOME: claudeHome } });
    ctx.s.usage.poll(Date.parse('2026-11-01T10:00:00.000Z'));
    const later = Date.parse('2026-11-01T20:00:00.000Z');
    expect(ctx.s.usage.current(later).codex.five_hour?.usedPercent).toBe(0);
    ctx.s.usage.recordReading({ agent: 'claude', window: 'five_hour', usedPercent: 77, resetsAt: new Date(Date.now() + 3600_000).toISOString(), source: 'claude-sdk' });
    expect(ctx.s.usage.current().claude.five_hour).toMatchObject({ usedPercent: 77, estimate: false });
  });
});
