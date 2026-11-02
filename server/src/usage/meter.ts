import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/index.ts';
import { all, get, run } from '../db/index.ts';
import type { EventBus } from '../events.ts';
import type { AgentId, AgentUsage, UsageState, UsageWindow } from '../types.ts';
import type { RateLimitReading } from '../runners/types.ts';
import { logger } from '../util/log.ts';
import { listJsonl, readNewJsonLines } from './logs.ts';
import type { FileCursor } from './logs.ts';

const log = logger('usage');

type Win = 'five_hour' | 'weekly';

export interface CodexRateLimits {
  ts: string;
  windows: Array<{ window: Win; usedPercent: number; resetsAt: string | null }>;
}

interface RawLimit {
  used_percent?: number;
  window_minutes?: number;
  resets_in_seconds?: number;
  resets_at?: number | string;
}

function toIso(v: number | string | undefined, baseMs: number, relativeSeconds?: number): string | null {
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  if (typeof relativeSeconds === 'number') return new Date(baseMs + relativeSeconds * 1000).toISOString();
  return null;
}

/** Extract `rate_limits` from one Codex session JSONL line (several historic shapes). */
export function parseCodexLine(line: unknown): CodexRateLimits | null {
  if (!line || typeof line !== 'object') return null;
  const l = line as Record<string, any>;
  const payload = l.type === 'event_msg' ? l.payload : l.msg ?? l.payload ?? l;
  if (!payload || payload.type !== 'token_count') return null;
  const rl = payload.rate_limits ?? payload.info?.rate_limits;
  if (!rl || typeof rl !== 'object') return null;
  const ts = typeof l.timestamp === 'string' ? l.timestamp : new Date().toISOString();
  const base = Date.parse(ts);
  const windows: CodexRateLimits['windows'] = [];
  for (const [key, fallback] of [['primary', 'five_hour'], ['secondary', 'weekly']] as const) {
    const w = rl[key] as RawLimit | undefined;
    if (!w || typeof w.used_percent !== 'number') continue;
    let window: Win = fallback;
    if (typeof w.window_minutes === 'number') window = w.window_minutes <= 600 ? 'five_hour' : 'weekly';
    windows.push({ window, usedPercent: w.used_percent, resetsAt: toIso(w.resets_at, base, w.resets_in_seconds) });
  }
  return windows.length ? { ts, windows } : null;
}

export class UsageMeter {
  private db: Db;
  private bus: EventBus;
  private codexHome: string;
  private codexCursors = new Map<string, FileCursor>();
  private lastCodexTs: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: { db: Db; bus: EventBus; codexHome: string }) {
    this.db = opts.db;
    this.bus = opts.bus;
    this.codexHome = opts.codexHome;
  }

  start(intervalSec: number): void {
    this.stop();
    const tick = () => {
      try {
        this.poll();
      } catch (err) {
        log.warn('usage poll failed', err);
      }
    };
    tick();
    this.timer = setInterval(tick, intervalSec * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Read Codex session logs changed since the last poll. Claude has no usable local log: its real
   * windows come from Claude Code itself (rate-limit events during runs and the agents probe).
   */
  poll(now = Date.now()): void {
    if (this.pollCodex()) this.bus.publish('usage.updated', this.current(now));
  }

  private pollCodex(): boolean {
    const dir = join(this.codexHome, 'sessions');
    if (!existsSync(dir)) return false;
    let newest: CodexRateLimits | null = null;
    for (const f of listJsonl(dir, 0)) {
      const prev = this.codexCursors.get(f.path);
      if (prev && prev.mtimeMs === f.mtimeMs && prev.size === f.size) continue;
      const { lines, cursor } = readNewJsonLines(f.path, prev);
      this.codexCursors.set(f.path, cursor);
      for (const line of lines) {
        const parsed = parseCodexLine(line);
        if (parsed && (!newest || parsed.ts > newest.ts)) newest = parsed;
      }
    }
    if (!newest || (this.lastCodexTs && newest.ts <= this.lastCodexTs)) return false;
    this.lastCodexTs = newest.ts;
    for (const w of newest.windows) this.insert('codex', w.window, w.usedPercent, null, w.resetsAt, 'codex-session-log', newest.ts);
    return true;
  }

  /** Authoritative reading from a live agent (Claude SDK `rate_limit_event`). */
  recordReading(r: RateLimitReading): void {
    this.insert(r.agent, r.window, r.usedPercent, null, r.resetsAt, r.source, new Date().toISOString());
    this.bus.publish('usage.updated', this.current());
  }

  private insert(agent: AgentId, window: Win, pct: number, tokens: number | null, resetsAt: string | null, source: string, ts: string, throttle = false): void {
    const rounded = Math.round(pct * 10) / 10;
    if (throttle) {
      const last = get<{ ts: string; used_percent: number }>(
        this.db,
        'SELECT ts, used_percent FROM usage_snapshots WHERE agent = ? AND window = ? AND source = ? ORDER BY ts DESC LIMIT 1',
        agent, window, source,
      );
      if (last && Math.abs(last.used_percent - rounded) < 0.5 && Date.parse(ts) - Date.parse(last.ts) < 30 * 60_000) return;
    }
    run(
      this.db,
      'INSERT INTO usage_snapshots (ts, agent, window, used_percent, tokens, resets_at, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ts, agent, window, rounded, tokens, resetsAt, source,
    );
  }

  /**
   * Current plan state per agent/window from real readings only (Claude Code or Codex logs). A window
   * whose reset time has passed reads 0%; an agent with no reading yet reads null (unknown).
   */
  current(now = Date.now()): UsageState {
    const out: UsageState = { claude: { five_hour: null, weekly: null }, codex: { five_hour: null, weekly: null } };
    for (const agent of ['claude', 'codex'] as const) {
      for (const window of ['five_hour', 'weekly'] as const) {
        const rows = all<{ ts: string; used_percent: number; tokens: number | null; resets_at: string | null; source: string }>(
          this.db,
          `SELECT ts, used_percent, tokens, resets_at, source FROM usage_snapshots WHERE agent = ? AND window = ?
           ORDER BY ts DESC LIMIT 8`,
          agent, window,
        );
        // Old token-count estimates (before Nov 2026) are ignored: they were not the plan's real limits.
        const real = rows.filter((r) => r.source !== 'estimate');
        const pick = real.find((r) => !r.resets_at || Date.parse(r.resets_at) > now) ?? real[0];
        if (!pick) continue;
        const reset = pick.resets_at ? Date.parse(pick.resets_at) <= now : false;
        const w: UsageWindow = {
          usedPercent: reset ? 0 : pick.used_percent,
          resetsAt: reset ? null : pick.resets_at,
          source: pick.source,
          estimate: pick.source === 'estimate',
          tokens: pick.tokens,
          ts: pick.ts,
        };
        (out[agent] as AgentUsage)[window] = w;
      }
    }
    return out;
  }

  history(agent: AgentId, window: Win, sinceIso: string): Array<{ ts: string; used_percent: number }> {
    return all(this.db, 'SELECT ts, used_percent FROM usage_snapshots WHERE agent = ? AND window = ? AND ts >= ? ORDER BY ts', agent, window, sinceIso);
  }
}
