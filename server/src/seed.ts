import type { Services } from './app.ts';
import { get, run, tx } from './db/index.ts';
import type { ContextReport } from './tasks/context.ts';
import type { AgentId, TaskStatus, TaskType } from './types.ts';
import { newId } from './util/ids.ts';

/**
 * Believable demo data for mock mode, so every page can be judged without real agent logins.
 * Only runs on an empty database.
 */

const H = 3600_000;
const D = 24 * H;

interface SeedTask {
  title: string;
  body?: string;
  type: TaskType;
  status: TaskStatus;
  project?: string;
  agent?: AgentId;
  effort?: 'low' | 'medium' | 'high';
  ageH: number;
  summary?: string;
  reason?: string;
  outward?: boolean;
  priority?: number;
  approval?: { kind: string; summary: string; command: string; reason: string };
  events?: Array<[string, Record<string, unknown>]>;
  tokens?: [number, number];
  toolCalls?: number;
  due?: number;
}

const PROJECTS = [
  { key: 'clienteasy', name: 'ClientEasy', kind: 'code', repo: 'github.com/mukhesh/clienteasy', note: 'Projects/ClientEasy.md' },
  { key: 'jarvis', name: 'Jarvis', kind: 'code', repo: 'github.com/mukheshvadlamudi/jarvis', note: 'Projects/Jarvis.md' },
  { key: 'northwind', name: 'Northwind Dental', kind: 'client', repo: null, note: 'Projects/Northwind Dental.md' },
  { key: 'harbor', name: 'Harbor & Pine', kind: 'client', repo: null, note: 'Projects/Harbor & Pine.md' },
  { key: 'finances', name: 'Finances', kind: 'area', repo: null, note: 'Areas/Finances.md' },
] as const;

const codeEvents = (file: string, test: string): Array<[string, Record<string, unknown>]> => [
  ['status', { status: 'started', detail: 'Claude Code · worktree .jarvis-worktrees' }],
  ['message', { role: 'assistant', text: 'Reading the auth middleware and the failing test first.' }],
  ['tool_call', { id: 'toolu_1', tool: 'Grep', input: { pattern: 'refreshToken', path: 'src' } }],
  ['tool_result', { id: 'toolu_1', tool: 'Grep', output: `${file}:42:  const refreshToken = await store.get(userId);\n${file}:88:  if (!refreshToken) return null;` }],
  ['tool_call', { id: 'toolu_2', tool: 'Read', input: { file_path: file } }],
  ['tool_result', { id: 'toolu_2', tool: 'Read', output: '140 lines' }],
  ['message', { role: 'assistant', text: 'Two requests can refresh at once and the second one reads a token the first already rotated. A per-user lock around the refresh fixes it.' }],
  ['tool_call', { id: 'toolu_3', tool: 'Edit', input: { file_path: file, old_string: 'const refreshToken = await store.get(userId);', new_string: 'return withUserLock(userId, async () => {\n  const refreshToken = await store.get(userId);' } }],
  ['tool_result', { id: 'toolu_3', tool: 'Edit', output: `Applied edit to ${file}` }],
  ['file_change', { path: file, kind: 'update', additions: 18, deletions: 4 }],
  ['file_change', { path: test, kind: 'update', additions: 31, deletions: 0 }],
  ['tool_call', { id: 'toolu_4', tool: 'Bash', input: { command: 'npm test' } }],
  ['tool_result', { id: 'toolu_4', tool: 'Bash', output: ' ✓ test/auth/session.test.ts (11 tests) 388ms\n ✓ test/api/clients.test.ts (24 tests) 1.02s\n\n Test Files  14 passed (14)\n      Tests  128 passed (128)\n   Duration  6.21s' }],
  ['usage', { inputTokens: 84120, outputTokens: 6210, cachedTokens: 412000, costUsd: 0.41 }],
];

const researchEvents = (topic: string): Array<[string, Record<string, unknown>]> => [
  ['status', { status: 'started', detail: 'Codex thread · sandbox read-only · web search live' }],
  ['message', { role: 'reasoning', text: `Plan: find the main options for ${topic}, check independent comparisons, then pricing.` }],
  ['tool_call', { id: 'ws_1', tool: 'web_search', input: { query: `${topic} comparison 2026` } }],
  ['tool_result', { id: 'ws_1', tool: 'web_search', output: `Searched: ${topic} comparison 2026` }],
  ['tool_call', { id: 'ws_2', tool: 'web_search', input: { query: `${topic} pricing limits` } }],
  ['tool_result', { id: 'ws_2', tool: 'web_search', output: `Searched: ${topic} pricing limits` }],
  ['tool_call', { id: 'cmd_1', tool: 'shell', input: { command: 'cat > report.md' } }],
  ['tool_result', { id: 'cmd_1', tool: 'shell', output: '', exitCode: 0 }],
  ['file_change', { path: 'report.md', kind: 'add' }],
  ['usage', { inputTokens: 120400, outputTokens: 8800, cachedTokens: 96000 }],
];

const TASKS: SeedTask[] = [
  // Needs you
  {
    title: 'Push the session-lock fix for ClientEasy and open a PR', type: 'code', status: 'needs_you', project: 'clienteasy', agent: 'claude', ageH: 1.4, outward: true, priority: 2,
    reason: 'outward action → claude (per-tool approvals)',
    approval: { kind: 'git_push', summary: 'Bash: git push -u origin jarvis/t_8k2m-session-lock', command: 'git push -u origin jarvis/t_8k2m-session-lock', reason: 'All 128 tests pass; pushing so the PR can be opened.' },
    events: codeEvents('src/auth/session.ts', 'test/auth/session.test.ts').slice(0, 13), tokens: [61200, 4100], toolCalls: 5,
  },
  {
    title: 'Reply to Dr. Patel about the November invoice', body: 'She asked whether the October overage is included. It is not — draft a short, friendly reply with the corrected total.', type: 'admin', status: 'needs_you', project: 'northwind', agent: 'claude', ageH: 3.2, outward: true, priority: 1,
    reason: 'outward action → claude (per-tool approvals)',
    approval: { kind: 'outward_mcp', summary: 'mcp__gmail__send_message: Re: November invoice — Northwind Dental', command: 'to: priya.patel@northwind-dental.example\nsubject: Re: November invoice\n\nHi Priya,\n\nThe October overage (2.5 h) is billed separately, so November comes to £1,840. Updated invoice attached.\n\nBest,\nMukhesh', reason: 'Draft is ready; sending needs your OK.' },
    events: [
      ['status', { status: 'started', detail: 'Claude Code · data/workdirs' }],
      ['tool_call', { id: 'toolu_1', tool: 'mcp__gmail__search_threads', input: { query: 'from:priya.patel invoice' } }],
      ['tool_result', { id: 'toolu_1', tool: 'mcp__gmail__search_threads', output: '2 threads' }],
      ['tool_call', { id: 'toolu_2', tool: 'mcp__jarvis__read_note', input: { path: 'People/Priya Patel.md' } }],
      ['tool_result', { id: 'toolu_2', tool: 'mcp__jarvis__read_note', output: 'Prefers short emails; billing contact for Northwind.' }],
      ['message', { role: 'assistant', text: 'Drafted the reply with the corrected total (£1,840). Waiting for your approval to send.' }],
    ],
    tokens: [22400, 1900], toolCalls: 3,
  },
  // Running are created live by the mock runner (queued below).
  // Queued
  { title: 'Research the best Postgres backup tools for a small VPS', body: 'Compare pgBackRest, WAL-G, Barman and managed snapshots. I care about restore time, S3-compatible storage and how much RAM they need.', type: 'research', status: 'queued', ageH: 0.05, priority: 1 },
  { title: 'Fix the flaky date-picker test in ClientEasy', type: 'code', status: 'queued', project: 'clienteasy', ageH: 0.04 },
  { title: 'Draft the Harbor & Pine monthly report for October', type: 'write', status: 'queued', project: 'harbor', ageH: 0.03 },
  // Inbox
  { title: 'Look into moving Jarvis backups to Backblaze B2', type: 'research', status: 'inbox', project: 'jarvis', ageH: 20 },
  { title: 'Renew the ICO data protection fee', body: 'Due 14 Nov. Check if the Tier 1 fee changed.', type: 'admin', status: 'inbox', project: 'finances', ageH: 30, due: 12 * D },
  { title: 'Write a short case study on the Northwind booking flow', type: 'write', status: 'inbox', project: 'northwind', ageH: 52 },
  { title: 'Add CSV export to the ClientEasy invoices page', type: 'code', status: 'inbox', project: 'clienteasy', ageH: 75 },
  // Done
  { title: 'Fix the token refresh race in the auth middleware', type: 'code', status: 'done', project: 'clienteasy', agent: 'claude', ageH: 5, summary: 'Added a per-user lock around token refresh; 2 files changed (+49 −4), all 128 tests pass. Branch jarvis/t_3fq-token-refresh is ready.', reason: 'code → claude', events: codeEvents('src/auth/session.ts', 'test/auth/session.test.ts'), tokens: [84120, 6210], toolCalls: 4 },
  { title: 'Compare Plausible, Umami and Fathom for the Harbor & Pine site', type: 'research', status: 'done', project: 'harbor', agent: 'codex', ageH: 9, summary: 'Umami self-hosted fits best: free, cookieless, 60 MB RAM on their VPS. Plausible if they prefer hosted (€9/mo). Report saved to Research/2026-11-01-privacy-analytics.md.', reason: 'research → codex', events: researchEvents('privacy-friendly web analytics'), tokens: [120400, 8800], toolCalls: 3 },
  { title: 'Summarise unread email from the last two days', type: 'admin', status: 'done', agent: 'codex', ageH: 26, summary: '14 unread: 2 need replies (Dr. Patel — invoice question; Sam at Harbor & Pine — launch date), 1 receipt filed, the rest newsletters.', reason: 'admin → codex', tokens: [38100, 2400], toolCalls: 6 },
  { title: 'Weekly review — w/c 26 Oct', type: 'memory', status: 'done', agent: 'codex', ageH: 60, summary: 'Closed 11 tasks, 3 carried over. Updated Projects/ClientEasy.md (current sprint) and proposed 2 memory edits for approval.', reason: 'scheduled tasks → codex', tokens: [52000, 4100], toolCalls: 9 },
  { title: 'Write release notes for ClientEasy 2.4', type: 'write', status: 'done', project: 'clienteasy', agent: 'claude', ageH: 80, summary: 'Release notes drafted (412 words) from 23 merged PRs, grouped into Features, Fixes and Internal. Saved as docs/releases/2.4.md on the branch.', reason: 'write → claude', tokens: [46000, 3900], toolCalls: 7 },
  { title: 'Updates digest — Node, Vite and Hono releases', type: 'update', status: 'done', agent: 'codex', ageH: 30, summary: 'Node 24.11 (LTS) security release; Vite 7.2 adds environment API tweaks; Hono 4.10 — no breaking changes for Jarvis.', reason: 'scheduled tasks → codex', tokens: [21000, 1800], toolCalls: 4 },
  { title: 'Migrate ClientEasy reminders to the new job queue', type: 'code', status: 'done', project: 'clienteasy', agent: 'claude', effort: 'high', ageH: 110, summary: 'Reminders now run on the job queue with retries; removed the cron script. 6 files changed (+214 −131).', reason: 'high effort → claude', tokens: [212000, 18400], toolCalls: 31 },
  // Failed / cancelled
  { title: 'Run the Lighthouse audit on the Northwind staging site', type: 'code', status: 'failed', project: 'northwind', agent: 'codex', ageH: 14, summary: 'Staging returned 502 for every request — the site looks down. Nothing was changed.', reason: 'fallback: claude 5h at 88%', tokens: [9400, 600], toolCalls: 2,
    events: [
      ['status', { status: 'started', detail: 'Codex thread · sandbox workspace-write' }],
      ['tool_call', { id: 'cmd_1', tool: 'shell', input: { command: 'npx lighthouse https://staging.northwind-dental.example --quiet' } }],
      ['tool_result', { id: 'cmd_1', tool: 'shell', output: 'Runtime error encountered: The URL you have provided appears to be invalid.\nLighthouse was unable to reliably load the page you requested (Status code: 502).', exitCode: 1, isError: true }],
      ['error', { message: 'Staging returned 502 for every request — the site looks down.' }],
    ] },
  { title: 'Book a dentist appointment for next week', type: 'admin', status: 'cancelled', ageH: 40, summary: 'Cancelled by you.' },
];

const reportFor = (core: number, project: number, skills: number, budget = 6000): ContextReport => ({
  items: [
    { label: 'CORE.md', kind: 'core', path: 'CORE.md', tokens: core },
    ...(project ? [{ label: 'Project note', kind: 'project' as const, path: 'Projects/ClientEasy.md', tokens: project }] : []),
    { label: 'Skill descriptions (6)', kind: 'skills', tokens: skills },
    { label: 'Jarvis instructions', kind: 'instructions', tokens: 142 },
  ],
  totalTokens: core + project + skills + 142,
  budgetTokens: budget,
  truncated: false,
});

export function seedIfEmpty(s: Services, now = Date.now()): boolean {
  const n = get<{ n: number }>(s.db, 'SELECT COUNT(*) AS n FROM tasks')?.n ?? 0;
  if (n > 0) return false;
  const iso = (ms: number) => new Date(ms).toISOString();
  tx(s.db, () => {
    const projectIds: Record<string, string> = {};
    for (const p of PROJECTS) {
      const id = newId('p');
      projectIds[p.key] = id;
      run(s.db, 'INSERT INTO projects (id, name, kind, path, repo, vault_note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, p.name, p.kind, null, p.repo, p.note, iso(now - 40 * D));
    }

    for (const t of TASKS) {
      const id = newId('t');
      const created = now - t.ageH * H;
      const updated = t.status === 'queued' ? created : created + 0.3 * H;
      run(
        s.db,
        `INSERT INTO tasks (id, title, body, type, status, priority, project_id, agent_pref, agent, effort, created_at, updated_at, due_at,
          result_summary, outward, route_reason) VALUES (?, ?, ?, ?, ?, ?, ?, 'auto', ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, t.title, t.body ?? '', t.type, t.status, t.priority ?? 0, t.project ? projectIds[t.project] : null, t.agent ?? null, t.effort ?? 'medium',
        iso(created), iso(updated), t.due ? iso(now + t.due) : null, t.summary ?? null, t.outward ? 1 : 0, t.reason ?? null,
      );
      if (!t.agent || ['queued', 'inbox'].includes(t.status)) continue;
      const runId = newId('r');
      const runStatus = t.status === 'needs_you' ? 'failed' : t.status === 'cancelled' ? 'cancelled' : t.status;
      const [inTok, outTok] = t.tokens ?? [0, 0];
      run(
        s.db,
        `INSERT INTO runs (id, task_id, agent, session_id, cwd, started_at, ended_at, status, input_tokens, output_tokens, cached_tokens,
          cost_estimate_usd, tool_calls, error, context_report_json, route_reason, prompt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        runId, id, t.agent, `${t.agent === 'claude' ? '5b2f0c1e' : '019a3b77'}-${runId.slice(2)}`,
        t.type === 'code' ? `.jarvis-worktrees/${id}` : `data/workdirs/${id}`,
        iso(created + 60_000), t.status === 'needs_you' ? null : iso(created + 0.3 * H), runStatus === 'failed' && t.status === 'needs_you' ? 'done' : runStatus,
        inTok, outTok, Math.round(inTok * 3.2), t.agent === 'claude' ? Math.round(((inTok * 3 + outTok * 15) / 1e6) * 100) / 100 : 0,
        t.toolCalls ?? 0, t.status === 'failed' ? t.summary ?? null : null,
        JSON.stringify(reportFor(1630, t.project === 'clienteasy' ? 2210 : 0, 214)), t.reason ?? null, t.body ? `${t.title}\n\n${t.body}` : t.title,
      );
      let ts = created + 60_000;
      for (const [kind, payload] of t.events ?? []) {
        ts += 9_000 + Math.round(Math.random() * 20_000);
        run(s.db, 'INSERT INTO run_events (run_id, ts, kind, payload_json) VALUES (?, ?, ?, ?)', runId, iso(ts), kind, JSON.stringify(payload));
      }
      if (t.approval) {
        if (t.events) {
          run(s.db, 'INSERT INTO run_events (run_id, ts, kind, payload_json) VALUES (?, ?, ?, ?)', runId, iso(ts + 5000), 'tool_call',
            JSON.stringify({ id: 'toolu_approval', tool: t.approval.kind === 'git_push' ? 'Bash' : 'mcp__gmail__send_message', input: { command: t.approval.command }, risk: 'ask' }));
        }
        run(s.db, "UPDATE runs SET status = 'done', ended_at = ? WHERE id = ?", iso(ts + 6000), runId);
        run(
          s.db,
          `INSERT INTO approvals (id, run_id, task_id, kind, summary, detail_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
          newId('a'), runId, id, t.approval.kind, t.approval.summary,
          JSON.stringify({ tool: t.approval.kind === 'git_push' ? 'Bash' : 'mcp__gmail__send_message', input: { command: t.approval.command }, reason: t.approval.reason, agent: t.agent, runId }),
          iso(ts + 5000),
        );
      }
    }

    // A decided approval for history.
    run(s.db, `INSERT INTO approvals (id, run_id, task_id, kind, summary, detail_json, status, created_at, decided_at, decided_via, note)
      VALUES (?, NULL, NULL, 'git_push', 'Bash: git push origin jarvis/t_7pd-release-notes', ?, 'approved', ?, ?, 'web', 'Looks good')`,
      newId('a'), JSON.stringify({ tool: 'Bash', input: { command: 'git push origin jarvis/t_7pd-release-notes' }, reason: 'Release notes reviewed.' }), iso(now - 78 * H), iso(now - 77.6 * H));

    // 14 days of background runs so the usage charts have shape.
    const kinds: Array<[TaskType, AgentId, string]> = [
      ['code', 'claude', 'Refactor the ClientEasy clients table into smaller components'],
      ['research', 'codex', 'Find a cheaper SMS provider for appointment reminders'],
      ['admin', 'codex', 'Triage inbox and file receipts'],
      ['write', 'claude', 'Draft the Northwind newsletter intro'],
      ['update', 'codex', 'Updates digest'],
      ['code', 'claude', 'Fix timezone bug in booking confirmations'],
      ['memory', 'codex', 'Memory consolidation'],
    ];
    for (let day = 13; day >= 1; day--) {
      const count = 2 + ((day * 7) % 4);
      for (let i = 0; i < count; i++) {
        const [type, agent, title] = kinds[(day + i) % kinds.length];
        const id = newId('t');
        const at = now - day * D + (9 + i * 2.5) * H;
        const scale = agent === 'claude' ? 1 : 0.7;
        const inTok = Math.round((30000 + ((day * 13 + i * 29) % 70) * 1500) * scale);
        const outTok = Math.round(inTok * 0.07);
        run(s.db, `INSERT INTO tasks (id, title, body, type, status, priority, agent_pref, agent, effort, created_at, updated_at, result_summary, route_reason)
          VALUES (?, ?, '', ?, 'done', 0, 'auto', ?, 'medium', ?, ?, ?, ?)`,
          id, title, type, agent, iso(at), iso(at + 0.4 * H), 'Completed.', `${type} → ${agent}`);
        run(s.db, `INSERT INTO runs (id, task_id, agent, cwd, started_at, ended_at, status, input_tokens, output_tokens, cached_tokens, tool_calls, route_reason, context_report_json)
          VALUES (?, ?, ?, ?, ?, ?, 'done', ?, ?, ?, ?, ?, ?)`,
          newId('r'), id, agent, `data/workdirs/${id}`, iso(at), iso(at + 0.4 * H), inTok, outTok, inTok * 3, 3 + ((day + i) % 9), `${type} → ${agent}`,
          JSON.stringify(reportFor(1630, 0, 214)));
      }
    }

    // Plan usage history: 5-hour windows rising and resetting, weekly climbing.
    for (let h = 7 * 24; h >= 2; h -= 2) {
      const ts = now - h * H;
      const phase = (h % 5) / 5;
      const dayFactor = new Date(ts).getHours() >= 8 && new Date(ts).getHours() <= 22 ? 1 : 0.2;
      const c5 = Math.round((1 - phase) * 70 * dayFactor);
      const x5 = Math.round((1 - phase) * 45 * dayFactor);
      const nextReset = ts + (5 - (h % 5)) * H;
      run(s.db, `INSERT INTO usage_snapshots (ts, agent, window, used_percent, resets_at, source) VALUES (?, 'claude', 'five_hour', ?, ?, 'claude-sdk')`, iso(ts), c5, iso(nextReset));
      run(s.db, `INSERT INTO usage_snapshots (ts, agent, window, used_percent, resets_at, source) VALUES (?, 'codex', 'five_hour', ?, ?, 'codex-session-log')`, iso(ts), x5, iso(nextReset));
    }
    const weekReset = now + 2.6 * D;
    run(s.db, `INSERT INTO usage_snapshots (ts, agent, window, used_percent, resets_at, source) VALUES (?, 'claude', 'five_hour', 62, ?, 'claude-sdk')`, iso(now - 60_000), iso(now + 2.2 * H));
    run(s.db, `INSERT INTO usage_snapshots (ts, agent, window, used_percent, resets_at, source) VALUES (?, 'claude', 'weekly', 41, ?, 'claude-sdk')`, iso(now - 60_000), iso(weekReset));
    run(s.db, `INSERT INTO usage_snapshots (ts, agent, window, used_percent, resets_at, source) VALUES (?, 'codex', 'five_hour', 27.5, ?, 'codex-session-log')`, iso(now - 60_000), iso(now + 3.7 * H));
    run(s.db, `INSERT INTO usage_snapshots (ts, agent, window, used_percent, resets_at, source) VALUES (?, 'codex', 'weekly', 26, ?, 'codex-session-log')`, iso(now - 60_000), iso(now + 4.1 * D));
  });
  s.bus.publish('seeded', {});
  return true;
}
