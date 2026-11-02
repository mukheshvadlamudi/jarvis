import type { Db } from '../db/index.ts';
import { all } from '../db/index.ts';

export interface DailyTokens {
  date: string;
  claude: number;
  codex: number;
}

/** Per-day tokens per agent from finished runs over the last `days` days (local date). */
export function dailyTokens(db: Db, days = 14, now = new Date()): DailyTokens[] {
  const since = new Date(now.getTime() - days * 86400_000).toISOString();
  const rows = all<{ day: string; agent: string; tokens: number }>(
    db,
    `SELECT date(started_at, 'localtime') AS day, agent, SUM(input_tokens + output_tokens) AS tokens
     FROM runs WHERE started_at >= ? GROUP BY day, agent`,
    since,
  );
  const byDay = new Map<string, DailyTokens>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400_000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    byDay.set(key, { date: key, claude: 0, codex: 0 });
  }
  for (const r of rows) {
    const entry = byDay.get(r.day);
    if (entry && (r.agent === 'claude' || r.agent === 'codex')) entry[r.agent] += r.tokens ?? 0;
  }
  return [...byDay.values()];
}

export function tokensByType(db: Db, days = 14, now = new Date()): Array<{ type: string; claude: number; codex: number; runs: number }> {
  const since = new Date(now.getTime() - days * 86400_000).toISOString();
  const rows = all<{ type: string; agent: string; tokens: number; n: number }>(
    db,
    `SELECT t.type AS type, r.agent AS agent, SUM(r.input_tokens + r.output_tokens) AS tokens, COUNT(*) AS n
     FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.started_at >= ? GROUP BY t.type, r.agent`,
    since,
  );
  const out = new Map<string, { type: string; claude: number; codex: number; runs: number }>();
  for (const r of rows) {
    const e = out.get(r.type) ?? { type: r.type, claude: 0, codex: 0, runs: 0 };
    if (r.agent === 'claude' || r.agent === 'codex') e[r.agent] += r.tokens ?? 0;
    e.runs += r.n;
    out.set(r.type, e);
  }
  return [...out.values()].sort((a, b) => b.claude + b.codex - (a.claude + a.codex));
}

export function routingLog(db: Db, limit = 40): Array<{ run_id: string; task_id: string; title: string; type: string; agent: string; route_reason: string | null; started_at: string; status: string; tokens: number }> {
  return all(
    db,
    `SELECT r.id AS run_id, r.task_id, t.title, t.type, r.agent, r.route_reason, r.started_at, r.status,
            r.input_tokens + r.output_tokens AS tokens
     FROM runs r JOIN tasks t ON t.id = r.task_id ORDER BY r.started_at DESC LIMIT ?`,
    limit,
  );
}
