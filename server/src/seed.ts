import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
    approval: { kind: 'git_push', summary: 'Push jarvis/t_8k2m-session-lock to origin', command: 'git push -u origin jarvis/t_8k2m-session-lock', reason: 'All 128 tests pass; pushing so the PR can be opened.' },
    events: codeEvents('src/auth/session.ts', 'test/auth/session.test.ts').slice(0, 13), tokens: [61200, 4100], toolCalls: 5,
  },
  {
    title: 'Reply to Dr. Patel about the November invoice', body: 'She asked whether the October overage is included. It is not — draft a short, friendly reply with the corrected total.', type: 'admin', status: 'needs_you', project: 'northwind', agent: 'claude', ageH: 3.2, outward: true, priority: 1,
    reason: 'outward action → claude (per-tool approvals)',
    approval: { kind: 'outward_mcp', summary: 'Send “Re: November invoice” to priya.patel@northwind-dental.example', command: 'to: priya.patel@northwind-dental.example\nsubject: Re: November invoice\n\nHi Priya,\n\nThe October overage (2.5 h) is billed separately, so November comes to £1,840. Updated invoice attached.\n\nBest,\nMukhesh', reason: 'Draft is ready; sending needs your OK.' },
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

    seedConversations(s, now, projectIds);

    // A decided approval for history.
    run(s.db, `INSERT INTO approvals (id, run_id, task_id, kind, summary, detail_json, status, created_at, decided_at, decided_via, note)
      VALUES (?, NULL, NULL, 'git_push', 'Push jarvis/t_7pd-release-notes to origin', ?, 'approved', ?, ?, 'web', 'Looks good')`,
      newId('a'), JSON.stringify({ tool: 'Bash', input: { command: 'git push origin jarvis/t_7pd-release-notes' }, reason: 'Release notes reviewed.' }), iso(now - 78 * H), iso(now - 77.6 * H));

    // 14 days of background runs so the usage charts have shape.
    const kinds: Array<[TaskType, AgentId, string, string]> = [
      ['code', 'claude', 'Refactor the ClientEasy clients table into smaller components', 'Split ClientsTable into 4 components; no behaviour change, 41 tests pass.'],
      ['research', 'codex', 'Find a cheaper SMS provider for appointment reminders', 'Twilio → Plivo saves ~38% at 2k SMS/month; UK sender IDs supported. Report saved to Research.'],
      ['admin', 'codex', 'Triage inbox and file receipts', '9 threads triaged, 3 receipts filed to Finances, 1 reply drafted (not sent).'],
      ['write', 'claude', 'Draft the Northwind newsletter intro', 'Intro drafted (180 words) in the clinic’s friendly tone; two subject-line options included.'],
      ['update', 'codex', 'Updates digest', '6 new items: 2 security releases worth applying, 4 minor.'],
      ['code', 'claude', 'Fix timezone bug in booking confirmations', 'Confirmations now render in the clinic’s timezone; added a DST regression test.'],
      ['memory', 'codex', 'Memory consolidation', 'Proposed 3 edits: 2 stale facts removed, 1 project note trimmed under its cap.'],
    ];
    for (let day = 13; day >= 1; day--) {
      const count = 2 + ((day * 7) % 4);
      for (let i = 0; i < count; i++) {
        const [type, agent, title, summary] = kinds[(day + i) % kinds.length];
        const id = newId('t');
        const at = now - day * D + (9 + i * 2.5) * H;
        const scale = agent === 'claude' ? 1 : 0.7;
        const inTok = Math.round((30000 + ((day * 13 + i * 29) % 70) * 1500) * scale);
        const outTok = Math.round(inTok * 0.07);
        run(s.db, `INSERT INTO tasks (id, title, body, type, status, priority, agent_pref, agent, effort, created_at, updated_at, result_summary, route_reason)
          VALUES (?, ?, '', ?, 'done', 0, 'auto', ?, 'medium', ?, ?, ?, ?)`,
          id, title, type, agent, iso(at), iso(at + 0.4 * H), summary, `${type} → ${agent}`);
        run(s.db, `INSERT INTO runs (id, task_id, agent, cwd, started_at, ended_at, status, input_tokens, output_tokens, cached_tokens, tool_calls, route_reason, context_report_json)
          VALUES (?, ?, ?, ?, ?, ?, 'done', ?, ?, ?, ?, ?, ?)`,
          newId('r'), id, agent, `data/workdirs/${id}`, iso(at), iso(at + 0.4 * H), inTok, outTok, inTok * 3, 3 + ((day + i) % 9), `${type} → ${agent}`,
          JSON.stringify(reportFor(1630, 0, 214)));
      }
    }

    // Plan usage history: 5-hour windows rising and resetting, weekly climbing.
    let c5 = 0;
    let x5 = 0;
    for (let h = 7 * 24; h >= 1; h--) {
      const ts = now - h * H;
      const hour = new Date(ts).getHours();
      if (h % 5 === 0) {
        c5 = 0;
        x5 = 0;
      }
      const active = hour >= 8 && hour <= 22 ? 1 : 0;
      const wiggle = ((h * 37) % 11) / 10;
      c5 = Math.min(96, c5 + active * (9 + wiggle * 14));
      x5 = Math.min(90, x5 + active * (5 + wiggle * 9));
      const nextReset = ts + (h % 5 || 5) * H;
      run(s.db, `INSERT INTO usage_snapshots (ts, agent, window, used_percent, resets_at, source) VALUES (?, 'claude', 'five_hour', ?, ?, 'claude-sdk')`, iso(ts), Math.round(c5), iso(nextReset));
      run(s.db, `INSERT INTO usage_snapshots (ts, agent, window, used_percent, resets_at, source) VALUES (?, 'codex', 'five_hour', ?, ?, 'codex-session-log')`, iso(ts), Math.round(x5), iso(nextReset));
    }
    const weekReset = now + 2.6 * D;
    run(s.db, `INSERT INTO usage_snapshots (ts, agent, window, used_percent, resets_at, source) VALUES (?, 'claude', 'five_hour', 62, ?, 'claude-sdk')`, iso(now - 60_000), iso(now + 2.2 * H));
    run(s.db, `INSERT INTO usage_snapshots (ts, agent, window, used_percent, resets_at, source) VALUES (?, 'claude', 'weekly', 41, ?, 'claude-sdk')`, iso(now - 60_000), iso(weekReset));
    run(s.db, `INSERT INTO usage_snapshots (ts, agent, window, used_percent, resets_at, source) VALUES (?, 'codex', 'five_hour', 27.5, ?, 'codex-session-log')`, iso(now - 60_000), iso(now + 3.7 * H));
    run(s.db, `INSERT INTO usage_snapshots (ts, agent, window, used_percent, resets_at, source) VALUES (?, 'codex', 'weekly', 26, ?, 'codex-session-log')`, iso(now - 60_000), iso(now + 4.1 * D));
  });
  seedMemory(s, now);
  seedSchedules(s, now);
  seedWorkspaces(s, now);
  s.bus.publish('seeded', {});
  return true;
}

/** Ask history uses the same stored events as live conversations. */
function seedConversations(s: Services, now: number, projectIds: Record<string, string>): void {
  const iso = (ms: number) => new Date(ms).toISOString();
  const typed = (s.db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>).some((c) => c.name === 'purpose');
  const conversations = [
    {
      id: 't_demo_auth', title: 'ClientEasy auth review', project: 'clienteasy', type: 'code' as const,
      agent: 'claude' as const, model: 'claude-sonnet-4-6', effort: 'high', ago: 0.8 * H,
      prompt: 'Review the auth middleware in ClientEasy. What should we fix before the Northwind launch?',
      thinking: 'I’ll trace session refresh and route protection, then check the tests. I’ll separate confirmed failure paths from risks that depend on deployment.',
      answer: 'The main risk is **concurrent token refresh**. Two requests can read the same refresh token before either writes the replacement.\n\n### Before the Northwind launch\n\n1. **Serialize refresh per user.** Put the read and rotation inside the same lock in `src/auth/session.ts`.\n2. **Reject expired sessions consistently.** Return `401` from the API and let the client show the sign-in screen.\n3. **Cover parallel requests.** Add a test that refreshes twice at once and verifies both requests receive the current session.\n\nThe route guard already checks workspace membership. Keep that check on the server. I’ve only reviewed the code; no files changed.',
      steps: [
        { tool: 'Read', input: { file_path: 'src/auth/session.ts' }, activity: 'Reading src/auth/session.ts', output: 'Refresh reads the stored token before rotating it; no per-user lock.' },
        { tool: 'Grep', input: { pattern: 'requireSession', path: 'src/api' }, activity: 'Tracing session checks across API routes', output: 'Protected routes use requireSession and verify workspace membership.' },
        { tool: 'Read', input: { file_path: 'test/auth/session.test.ts' }, activity: 'Checking coverage for concurrent refresh requests', output: 'Expiry is covered; parallel refresh is not covered.' },
      ],
    },
    {
      id: 't_demo_backups', title: 'ClientEasy backup decision', project: 'clienteasy', type: 'other' as const,
      agent: 'codex' as const, model: 'gpt-5.3-codex', effort: 'medium', ago: 3 * H,
      prompt: 'What did I decide about the ClientEasy backups?',
      thinking: 'I’ll find the decision in the project note and check the daily entry for any later change. A plan to test restore is different from a verified backup.',
      answer: 'You chose **nightly encrypted Postgres backups to B2**, with a weekly restore check on a separate database.\n\n- Keep 14 daily copies and 8 weekly copies.\n- Keep credentials outside the repository.\n- Confirm a restore before moving Northwind onto the new setup.\n\nThe project note records the decision. The daily entry still lists the first restore drill as open, so the setup is **not yet verified**.\n\nSource: `Projects/ClientEasy.md`, “Backups” and the 1 November daily note.',
      steps: [
        { tool: 'mcp__jarvis__search_memory', input: { query: 'ClientEasy backups' }, activity: 'Checking your notes for “ClientEasy backups”', output: 'Found Projects/ClientEasy.md and DAILY/2026-11-01.md.' },
        { tool: 'mcp__jarvis__read_note', input: { path: 'Projects/ClientEasy.md' }, activity: 'Reading the backup decision in ClientEasy', output: 'Nightly encrypted backups to B2; 14 daily and 8 weekly copies; weekly restore drill.' },
        { tool: 'mcp__jarvis__read_note', input: { path: 'DAILY/2026-11-01.md' }, activity: 'Checking whether the restore drill is complete', output: 'First restore drill remains open before the Northwind launch.' },
      ],
    },
    {
      id: 't_demo_launch', title: 'Harbor & Pine launch reply', project: 'harbor', type: 'write' as const,
      agent: 'claude' as const, model: 'claude-sonnet-4-6', effort: 'low', ago: 22 * H,
      prompt: 'Use the attached launch checklist to draft a short reply to Sam. Keep the date conditional on the final content review.',
      thinking: 'I’ll read the checklist and the client note, then draft a reply that makes the outstanding review clear without promising a firm launch date.',
      answer: 'Here’s a draft for Sam:\n\n> Hi Sam,\n>\n> We’re aiming for Thursday for the Harbor & Pine launch, provided the final content review is signed off by Wednesday afternoon. The remaining items are the returns copy and the two product photos on your checklist.\n>\n> If those need more time, I’ll confirm a revised date once they’re ready.\n>\n> Best,\n> Mukhesh\n\nDraft only. Nothing has been sent.',
      steps: [
        { tool: 'Read', input: { file_path: 'attachments/launch-checklist.md' }, activity: 'Reading the attached launch checklist', output: 'Open: returns copy and two product photos. Target: Thursday, conditional on content approval.' },
        { tool: 'mcp__jarvis__read_note', input: { path: 'Projects/Harbor & Pine.md' }, activity: 'Checking the Harbor & Pine launch context', output: 'Sam owns final content sign-off. Keep client replies short and specific.' },
      ],
    },
  ];
  for (const c of conversations) {
    const at = now - c.ago;
    const reason = c.agent === 'claude' ? `${c.type} → claude` : 'question → codex (more plan room)';
    run(s.db, `INSERT INTO tasks (id, title, body, type, status, project_id, agent_pref, agent, effort, mode, created_at, updated_at, result_summary, route_reason)
      VALUES (?, ?, ?, ?, 'done', ?, 'auto', ?, ?, 'chat', ?, ?, ?, ?)`,
      c.id, c.title, c.prompt, c.type, projectIds[c.project], c.agent, c.effort, iso(at), iso(at + 40_000), c.answer, reason);
    const addRun = (agent: AgentId, model: string, answer: string, routeReason: string, start: number, purpose = 'user_reply', parent: string | null = null) => {
      const id = newId('r');
      const side = purpose !== 'user_reply';
      const attachments = c.id === 't_demo_launch' ? JSON.stringify([{ id: 'u_demo_launch', name: 'launch-checklist.md', mime: 'text/markdown', size: 1240, path: 'attachments/launch-checklist.md' }]) : null;
      run(s.db, `INSERT INTO runs (id, task_id, agent, cwd, started_at, ended_at, status, prompt, answer, model, effort, route_reason, attachments_json, tool_calls, input_tokens, output_tokens)
        VALUES (?, ?, ?, ?, ?, ?, 'done', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, c.id, agent, `data/workdirs/${c.id}`, iso(start), iso(start + 14_000),
        side ? 'Give a read-only second opinion on Claude’s ClientEasy auth review.' : c.prompt,
        answer, model, c.effort, routeReason, attachments, c.steps.length, side ? 8400 : 12480, side ? 340 : 760);
      if (typed) run(s.db, 'UPDATE runs SET purpose = ?, visibility = ?, owner_text = ?, parent_run_id = ? WHERE id = ?', purpose, purpose === 'consult' ? 'activity' : 'conversation', side ? null : c.prompt, parent, id);
      let ts = start;
      const event = (kind: string, payload: Record<string, unknown>) => {
        ts += 1000;
        run(s.db, 'INSERT INTO run_events (run_id, ts, kind, payload_json) VALUES (?, ?, ?, ?)', id, iso(ts), kind, JSON.stringify(payload));
      };
      event('message', { role: 'reasoning', text: side ? 'I’ll check the session boundary and the proposed locking strategy independently.' : c.thinking });
      c.steps.forEach((step, i) => {
        const { output, ...call } = step;
        event('tool_call', { id: `step_${i + 1}`, ...call });
        event('tool_result', { id: `step_${i + 1}`, tool: step.tool, output });
      });
      event('message', { role: 'assistant', text: answer });
      return id;
    };
    const richAnswer = c.id === 't_demo_backups' ? `${c.answer}\n\n### Retention at a glance\n\n| Copy | Keep | Check |\n| :--- | ---: | :--- |\n| Daily | 14 copies | Encrypted upload |\n| Weekly | 8 copies | Restore to a separate database |\n\n### The backup path\n\n\`\`\`mermaid\nflowchart LR\n  A[Postgres] --> B[Encrypted backup]\n  B --> C[B2 storage]\n  C --> D[Restore check]\n\`\`\`\n\nThe restore check should verify the database before it is removed:\n\n\`\`\`sh\npg_restore --dbname=restore_check --exit-on-error nightly.dump\n\`\`\`` : c.answer;
    const primary = addRun(c.agent, c.model, richAnswer, reason, at);
    if (c.id === 't_demo_auth') {
      addRun('codex', 'gpt-5.3-codex', 'The API already checks workspace membership. I checked the protected routes independently; keep that boundary on the server.', 'consult:codex', at + 5000, 'consult', primary);
      addRun('codex', 'gpt-5.3-codex', 'I agree with the refresh-race finding. One caveat: **an in-memory lock only protects one server process**. If ClientEasy runs more than one worker, use a database transaction or a shared lock.\n\nFor the current single-process setup, the per-user lock and a parallel-request test are a reasonable fix.', 'side:second opinion:Codex checked Claude', at + 20_000, 'second_opinion', primary);
    }
  }
}

/** Demo memory + skill proposals so the review flows have something real to show. */
function seedMemory(s: Services, now: number): void {
  const mem = s.modules.memory as { proposals: { propose: (i: { target: string; content: string; reason: string; mode?: 'append' | 'replace'; runId?: string | null }) => unknown } } | undefined;
  if (!mem) return;
  const runId = get<{ id: string }>(s.db, "SELECT id FROM runs WHERE status = 'done' ORDER BY started_at DESC LIMIT 1")?.id ?? null;
  try {
    mem.proposals.propose({ target: 'People/Priya Patel.md', content: '- Approved deposit amounts on 2 Nov: £20 check-up, £50 hygiene.', reason: 'Priya confirmed by email; closes the sign-off thread.', runId });
    mem.proposals.propose({ target: 'Projects/ClientEasy.md', content: '- 2026-11-02: token refresh race fixed on jarvis/t_3fq-token-refresh (PR pending approval).', reason: 'Keep current state accurate for the next coding run.', runId });
    mem.proposals.propose({ target: 'CORE.md', content: '- Prefers invoice PDFs attached, not links.', reason: 'Mentioned while triaging email.', runId });
  } catch {
    // vault missing or read-only: skip demo proposals
  }
  run(
    s.db,
    `INSERT INTO skill_proposals (id, run_id, name, description, body, status, created_at, existing) VALUES (?, ?, ?, ?, ?, 'pending', ?, 0)`,
    newId('sp'), runId, 'staging-health-check',
    'Check a client staging site end to end before audits: container, TLS, 5xx rate, then Lighthouse.',
    '# Staging health check\n\n1. `docker ps` on the VPS — is the site container up and healthy?\n2. `curl -sI https://staging.<site>` — expect 200 and a valid certificate.\n3. Check the last 100 access-log lines for 5xx.\n4. Only then run Lighthouse (`npx lighthouse <url> --quiet --output json`).\n5. Report findings; never restart containers without approval.\n',
    new Date(now - 13 * H).toISOString(),
  );
}

/** Turn on two routines, add a custom schedule and some history. */
function seedSchedules(s: Services, now: number): void {
  const has = get<{ n: number }>(s.db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'schedules'")?.n;
  if (!has) return;
  const iso = (ms: number) => new Date(ms).toISOString();
  run(s.db, "UPDATE schedules SET enabled = 1, enabled_at = ? WHERE built_in IN ('morning_brief', 'updates_digest', 'weekly_review')", iso(now - 20 * D));
  const custom = newId('sc');
  run(s.db, `INSERT INTO schedules (id, name, cron, task_template_json, enabled, description, created_at, enabled_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
    custom, 'Chase unpaid invoices', '0 10 15 * *', JSON.stringify({ title: 'Chase unpaid invoices', type: 'admin', body: 'List invoices older than 14 days from ClientEasy and draft polite reminders (drafts only).' }),
    'Mid-month reminder drafts for anything over 14 days.', iso(now - 30 * D), iso(now - 30 * D));
  run(s.db, `INSERT INTO schedules (id, name, cron, task_template_json, enabled, description, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)`,
    newId('sc'), 'Renewals check', '0 9 1 * *', JSON.stringify({ title: 'Check upcoming renewals (domains, ICO, insurance)', type: 'admin' }), 'Anything renewing in the next 45 days.', iso(now - 30 * D));
  const ids = Object.fromEntries((s.db.prepare('SELECT id, built_in FROM schedules WHERE built_in IS NOT NULL').all() as Array<{ id: string; built_in: string }>).map((r) => [r.built_in, r.id]));
  const taskFor = (title: string) => get<{ id: string }>(s.db, 'SELECT id FROM tasks WHERE title LIKE ? ORDER BY created_at DESC LIMIT 1', `${title}%`)?.id ?? null;
  const add = (sid: string, ago: number, kind: string, title: string | null, note: string | null = null) =>
    run(s.db, 'INSERT INTO schedule_runs (schedule_id, ts, due_at, kind, task_id, note) VALUES (?, ?, ?, ?, ?, ?)', sid, iso(now - ago), iso(now - ago), kind, title ? taskFor(title) : null, note);
  add(ids.updates_digest, 30 * H, 'scheduled', 'Updates digest — Node');
  add(ids.weekly_review, 60 * H, 'scheduled', 'Weekly review');
  add(ids.morning_brief, 26 * H, 'missed', 'Summarise unread email', 'Ran on wake (missed while asleep)');
  add(ids.morning_brief, 74 * H, 'skipped', null, 'Missed by 14 h (over 12 h) — skipped');
  // Mark the weekly and monthly ones as recently run so boot catch-up doesn't log stale skips.
  run(s.db, "UPDATE schedules SET last_run_at = ? WHERE id IN (?, ?, ?)", iso(now - 60_000), ids.weekly_review, ids.updates_digest, custom);
}

/** Feeds with items, and (mock mode) a small real git repo so Projects shows actual worktrees. */
function seedWorkspaces(s: Services, now: number): void {
  const has = get<{ n: number }>(s.db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'feed_sources'")?.n;
  if (!has) return;
  const iso = (ms: number) => new Date(ms).toISOString();
  const sources: Array<[string, string, string, Array<[string, string, string, number, boolean]>]> = [
    ['Node.js Blog', 'https://nodejs.org/en/feed/blog.xml', 'rss', [
      ['Node.js 24.11.1 (LTS) — security release', 'https://nodejs.org/en/blog/release/v24.11.1', 'Fixes two medium-severity issues in http and the permission model. Upgrade recommended.', 5 * D, false],
      ['Node.js 25.2.0 (Current)', 'https://nodejs.org/en/blog/release/v25.2.0', 'New --watch-preserve-output flag, faster require(esm), and SQLite updates.', 11 * D, true],
    ]],
    ['hono releases', 'https://github.com/honojs/hono/releases.atom', 'github', [
      ['v4.13.17', 'https://github.com/honojs/hono/releases/tag/v4.13.17', "What's Changed — fix(streaming): close SSE streams on client abort.", 3 * D, false],
      ['v4.13.16', 'https://github.com/honojs/hono/releases/tag/v4.13.16', 'Performance improvements for the RegExpRouter.', 12 * D, true],
    ]],
    ['vite releases', 'https://github.com/vitejs/vite/releases.atom', 'github', [
      ['v8.3.5', 'https://github.com/vitejs/vite/releases/tag/v8.3.5', 'Fix CSS url() rewriting for aliased font paths; dev server now respects server.host for HMR.', 1.5 * D, false],
      ['create-vite@8.3.0', 'https://github.com/vitejs/vite/releases/tag/create-vite%408.3.0', 'React and Vue templates updated to the latest majors.', 6 * D, true],
    ]],
    ['Claude Code changelog', 'https://github.com/anthropics/claude-code/releases.atom', 'github', [
      ['v2.3.4', 'https://github.com/anthropics/claude-code/releases/tag/v2.3.4', 'Agent SDK: rate_limit_event now includes utilization for subscription plans; faster MCP startup.', 0.6 * D, false],
    ]],
    ['Hetzner Status', 'https://status.hetzner.com', 'page', [
      ['Hetzner Status changed', 'https://status.hetzner.com', 'Scheduled maintenance: fsn1 network, 6 Nov 02:00–04:00 UTC. Short packet loss possible.', 0.3 * D, false],
    ]],
  ];
  for (const [name, url, kind, items] of sources) {
    const id = newId('f');
    run(s.db, 'INSERT INTO feed_sources (id, name, url, kind, enabled, last_checked_at, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)', id, name, url, kind, iso(now - 2 * H), iso(now - 30 * D));
    for (const [title, link, summary, ago, seen] of items) {
      run(s.db, 'INSERT INTO feed_items (id, source_id, guid, title, url, published_at, summary, seen, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', newId('fi'), id, link, title, link, iso(now - ago), summary, seen ? 1 : 0, iso(now - ago + H));
    }
  }

  // Link the seeded analytics research task to its report.
  run(s.db, "UPDATE tasks SET output_path = 'Research/2026-11-01-privacy-analytics.md' WHERE title LIKE 'Compare Plausible%'");

  if (s.env.runner !== 'mock' || process.env.JARVIS_SEED_REPOS === '0') return;
  try {
    const repo = join(s.env.dataDir, 'demo-repos', 'clienteasy');
    mkdirSync(join(repo, 'src', 'auth'), { recursive: true });
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Mukhesh', '-c', 'user.email=owner@example.com', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'CLAUDE.md'), '# ClientEasy — agent rules\n\n- TypeScript strict; run `npm test` before committing.\n- Database migrations are additive only.\n- Add a CHANGELOG line under Unreleased for every PR.\n');
    writeFileSync(join(repo, 'AGENTS.md'), 'Same rules as CLAUDE.md.\n');
    writeFileSync(join(repo, 'src', 'auth', 'session.ts'), 'export async function refresh(userId: string) {\n  const refreshToken = await store.get(userId);\n  if (!refreshToken) return null;\n  return rotate(refreshToken);\n}\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'ClientEasy 2.4');
    const task = get<{ id: string }>(s.db, "SELECT id FROM tasks WHERE title = 'Fix the token refresh race in the auth middleware'");
    if (task) {
      const wt = join(repo, '.jarvis-worktrees', task.id);
      git(repo, 'worktree', 'add', '-q', '-b', `jarvis/${task.id}-fix-the-token-refresh-race`, wt);
      writeFileSync(join(wt, 'src', 'auth', 'session.ts'), 'import { withUserLock } from "./lock";\n\nexport async function refresh(userId: string) {\n  return withUserLock(userId, async () => {\n    const refreshToken = await store.get(userId);\n    if (!refreshToken) return null;\n    return rotate(refreshToken);\n  });\n}\n');
      writeFileSync(join(wt, 'src', 'auth', 'lock.ts'), 'const locks = new Map<string, Promise<unknown>>();\n\nexport async function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {\n  const prev = locks.get(userId) ?? Promise.resolve();\n  const next = prev.then(fn, fn);\n  locks.set(userId, next.catch(() => undefined));\n  return next;\n}\n');
      git(wt, 'add', '.');
      git(wt, 'commit', '-qm', 'Serialise token refresh per user');
      run(s.db, 'UPDATE runs SET cwd = ? WHERE task_id = ?', wt, task.id);
    }
    run(s.db, "UPDATE projects SET path = ? WHERE name = 'ClientEasy'", repo);
  } catch {
    // git missing: Projects simply shows no local folder
  }
}
