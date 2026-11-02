# Jarvis — Build Spec

A personal command centre that runs **all of the owner's work** (coding, research, web search, email/admin, updates, routines) through the **official Claude Code and Codex agents**, billed to the owner's existing **Claude Pro** and **ChatGPT Plus** plans — never API keys. One local app to capture tasks, route them to the right agent, watch them run, approve risky actions, and keep a compact long-term memory.

Single user. Runs on a Windows 11 laptop with **8 GB RAM** (≈0.5–2 GB free in practice). Everything must stay light.

---

## 1. Hard constraints

1. **Plan usage only.** Agents run via the official SDKs, which launch the official CLIs using the logins already saved on the machine (`~/.claude/.credentials.json`, `~/.codex/auth.json` with `auth_mode: chatgpt`).
   - When spawning agents, **remove** `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `CODEX_API_KEY` from the child environment so a stray key can never switch billing to the API. Log a warning at startup if any are set.
   - Never use the Claude subscription login with anything except Anthropic's own SDK/CLI (third-party harness use is against Anthropic's terms).
2. **RAM budget.** Jarvis server ≤ ~150 MB. Max **2 concurrent agent runs** (configurable). No local LLMs, no vector DB, no Docker, no Redis, no Postgres.
3. **No native npm modules** (no `better-sqlite3`, no `node-gyp`). Use Node 24 built-ins: `node:sqlite`, `node:test` or vitest, `fetch`, `fs.watch`.
4. **Localhost by default.** Server binds `127.0.0.1`. Remote access (phone over Tailscale) only when `JARVIS_BIND` is changed **and** `JARVIS_ACCESS_TOKEN` is set; every request then needs the token.
5. **Nothing outward-facing without approval.** Sending email/messages, posting, pushing to a remote, opening PRs, deleting files outside a task worktree, purchases → always paused for owner approval.
6. **Secrets never in the repo or the vault.** `.env` is git-ignored. Credentials stay in the CLIs' own stores and connectors.
7. **Voice runs on the device, never on paid APIs.** (Changed by the owner: voice output is now allowed.) Hands-free voice uses Kokoro-82M for speech, Whisper for recognition and Silero VAD for turn-taking, all in the browser/desktop app — no ElevenLabs/Sarvam/cloud TTS, no credits. The mic button in inputs (Web Speech API) and the phone keyboard's mic in Telegram still work for dictation.

## 2. Stack

| Layer | Choice |
|---|---|
| Runtime | Node 24 LTS, TypeScript run directly via Node's type stripping (erasable syntax only: **no enums, no namespaces, no parameter properties**). `tsc --noEmit` for type checks. |
| Server | `hono` + `@hono/node-server`. Live updates via **SSE** (`/api/stream`). |
| DB | `node:sqlite` (`DatabaseSync`), WAL mode, single file `data/jarvis.db`. FTS5 for search — verify FTS5 is available at startup; fall back to `LIKE` search with a warning if not. |
| Claude agent | `@anthropic-ai/claude-agent-sdk` (`query()`). |
| Codex agent | `@openai/codex-sdk` (`Codex` → `startThread` / `resumeThread` → `runStreamed`). |
| Scheduling | `croner` (pure JS). |
| Web UI | Vite + React + TypeScript in `/web`, built to static files served by the server. Mobile-first, installable PWA (manifest + icons). No heavy UI kits; plain CSS with tokens, light/dark. |
| Telegram | Plain `fetch` long-polling against the Bot API (no bot framework dependency). Optional. |
| Tests | vitest (server + web logic). All tests run with `JARVIS_RUNNER=mock` — **no real agent calls in tests or CI**. |

> **SDK APIs move fast. Do not trust this spec for exact signatures.** After `npm install`, read the shipped `.d.ts` files in `node_modules/@anthropic-ai/claude-agent-sdk` and `node_modules/@openai/codex-sdk` and code against those. Keep all SDK-specific code inside `server/src/runners/` so changes stay local.

## 3. Repo layout

```
jarvis/
  SPEC.md  CLAUDE.md  AGENTS.md  README.md  .env.example
  package.json            # npm workspaces: server, web
  server/
    src/
      index.ts            # boot: config, db, migrations, services, http
      config.ts           # env + data/config.json (validated)
      db/                 # schema.sql, migrations, typed query helpers
      events.ts           # in-process event bus → SSE + Telegram
      tasks/              # task service, queue, state machine
      runners/            # AgentRunner interface; claude.ts, codex.ts, mock.ts
      router/             # routing rules + usage-aware fallback
      usage/              # plan usage meter (log parsers + run totals)
      approvals/          # approval service + risk policy
      mcp/                # Jarvis MCP server exposed to both agents
      memory/             # vault indexer, search, context builder, consolidation
      skills/             # skills registry, sync to ~/.claude & ~/.codex, learning loop
      scheduler/          # cron jobs, built-in routines
      workspaces/         # research, updates feed, code projects, people
      telegram/           # bot (optional)
      api/                # hono routes
    test/
  web/
    src/ pages/ components/ lib/
  fixtures/vault/         # fake vault used by tests and cloud builds
  data/                   # runtime (git-ignored): jarvis.db, logs, backups
```

### Module ownership (so builds can run in parallel)
- **Foundation (Phase 1):** `config`, `db`, `events`, `tasks`, `runners`, `router`, `usage`, `approvals`, `api` core, web shell + Phase 1 pages.
- **Memory & Skills (Phase 2a):** `memory/`, `skills/`, related API routes + pages.
- **Scheduler & routines (Phase 2b):** `scheduler/`, related routes + page.
- **Workspaces & Telegram (Phase 3):** `workspaces/`, `telegram/`, `mcp/` extras, related pages.
Each module registers its routes through `api/register.ts` and its pages through `web/src/routes.ts`, so parallel branches touch different files.

## 4. Data model (SQLite)

```
tasks(id, title, body, type, status, priority, project_id, agent_pref, agent, effort,
      parent_id, schedule_id, created_at, updated_at, due_at, result_summary, output_path)
  type   ∈ code | research | write | admin | update | memory | other
  status ∈ inbox | queued | running | needs_you | done | failed | cancelled
  agent_pref ∈ auto | claude | codex
runs(id, task_id, agent, session_id, cwd, started_at, ended_at, status,
     input_tokens, output_tokens, cached_tokens, cost_estimate_usd, tool_calls, error,
     context_report_json)
run_events(id, run_id, ts, kind, payload_json)
  kind ∈ message | tool_call | tool_result | file_change | status | usage | error
approvals(id, run_id, task_id, kind, summary, detail_json, status, created_at, decided_at, decided_via)
  status ∈ pending | approved | rejected | expired
usage_snapshots(id, ts, agent, window, used_percent, tokens, resets_at, source)
  window ∈ five_hour | weekly
projects(id, name, kind, path, repo, vault_note, created_at)   kind ∈ code | client | area
schedules(id, name, cron, task_template_json, enabled, last_run_at, next_run_at, built_in)
notes_index(path, title, type, status, tags, updated, project, tokens, mtime)
notes_fts(path, title, body)           -- FTS5 virtual table
skills(id, name, description, path, source, enabled, updated_at)
skill_proposals(id, run_id, name, description, body, status, created_at)
memory_proposals(id, run_id, target_path, diff, reason, status, created_at)
feed_sources(id, name, url, kind, enabled, last_checked_at)
feed_items(id, source_id, title, url, published_at, summary, seen)
settings(key, value_json)
```
Migrations are plain numbered `.sql` files applied in order at boot.

## 5. Core flow

1. **Capture** — web command bar, `POST /api/tasks`, Telegram message, schedule, or an agent calling the Jarvis MCP `create_task` tool. A cheap classifier assigns `type`, `project`, `effort` (rules first: keywords + project names; agent classification is optional and disabled by default to save usage).
2. **Route** — `router.decide(task, usage)` returns `{agent, reason}` (see §6). Reason is shown in the UI.
3. **Build context** — `memory.buildContext(task)` returns a prompt prefix + a **context report** (files loaded, tokens each, total). Stored on the run.
4. **Run** — `runner.start()` streams normalized events into `run_events` and the event bus. Concurrency ≤ `maxConcurrentRuns`; extra tasks wait in `queued`.
5. **Gate** — risky actions create an approval; the run pauses (`needs_you`) until decided from web or Telegram.
6. **Write back** — result summary on the task; outputs saved (`Research/…md`, branch/PR, draft); one line appended to today's vault daily note; memory/skill proposals created if warranted.
7. **Learn** — runs with ≥ `learning.minToolCalls` (default 8) tool calls trigger a skill-proposal step (see §9).

## Ask

- Conversations are tasks in `chat` mode; every message creates a run, answered immediately outside the background concurrency limit.
- Live thinking, real tool steps and streamed answers share one thread. Each message can choose an agent, model and effort; Ask both and Second opinion bring in the other agent. Remember saves an answer to notes; history is searchable.
- Question-shaped messages use the plan with more headroom (or the agent selected in Settings); instructions use task routing. Attachments are copied into the run folder; images and Claude PDFs go inline.
- Plan usage is reported by Claude Code itself and Codex session logs. The Connectors page manages each agent's MCP connections through its own CLI, from the owner UI only.
- Voice questions open conversations, speak occasional real activity cues, and read the opening 2–3 sentences of the answer.

## 6. Router

Config in `data/config.json` (defaults shipped in code):
```json
{
  "router": {
    "defaults": { "code": "claude", "write": "claude", "research": "codex",
                  "admin": "codex", "update": "codex", "memory": "codex", "other": "codex" },
    "effortOverride": { "high": "claude" },
    "scheduledTasks": "codex",
    "fallbackAtPercent": 85
  },
  "maxConcurrentRuns": 2
}
```
Rules, in order: explicit `agent_pref` → scheduled ⇒ `scheduledTasks` → `effort: high` ⇒ override → type default. Then usage check: if chosen agent's 5-hour or weekly `used_percent ≥ fallbackAtPercent` and the other is below, switch and record reason `"fallback: claude 5h at 91%"`. If both are exhausted, keep the task `queued` with `resets_at` shown and auto-retry after reset.

## 7. Runners

```ts
interface AgentRunner {
  readonly id: 'claude' | 'codex' | 'mock';
  start(input: RunInput, sink: RunEventSink): RunHandle;
}
interface RunInput { taskId: string; prompt: string; contextPrefix: string; cwd: string;
                     resumeSessionId?: string; sandbox: 'read-only' | 'workspace-write';
                     allowNetwork: boolean; }
interface RunHandle { done: Promise<RunResult>; cancel(): Promise<void>;
                      sendFollowUp?(text: string): Promise<void>; }
```
- **claude.ts** — `query({ prompt, options: { cwd, resume, permissionMode, canUseTool, mcpServers, settingSources, systemPrompt append with contextPrefix } })`. `canUseTool` consults the approvals risk policy (§8) and awaits a decision for risky calls. Map SDK messages (assistant text, tool_use, tool_result, result with usage) → normalized events. Load project `CLAUDE.md` / skills via `settingSources` so repo rules apply.
- **codex.ts** — `new Codex()`; `startThread({ workingDirectory: cwd, sandboxMode, skipGitRepoCheck: true, networkAccessEnabled })` (or `resumeThread(id)`); `runStreamed(prefix + prompt)`; map items (agent_message, command_execution, file_change, mcp_tool_call, web_search, turn.completed usage) → normalized events. **Always pass an explicit sandbox** — the owner's global Codex config uses `danger-full-access`; Jarvis must not inherit it. Default `workspace-write`, `read-only` for research/admin unless the task needs writes.
- **mock.ts** — deterministic scripted runs (success, tool calls, an approval request, failure, long-running/cancel) for tests and cloud builds.
- Coding tasks run in a **git worktree**: `<repo>/.jarvis-worktrees/<task-id>` on branch `jarvis/<task-id>-<slug>`. Non-code tasks run in `data/workdirs/<task-id>`.

## 8. Approvals & risk policy

`approvals/policy.ts` classifies each tool call as `safe | ask | block`:
- **ask:** shell commands matching `git push`, `gh pr create|merge`, `rm -r`/`Remove-Item -Recurse` outside the task cwd, `curl|Invoke-WebRequest` with POST/PUT/DELETE, package publish; MCP tools whose name matches `send|post|publish|delete|create_event|reply|share|transfer|purchase`; any file write outside the task cwd/vault.
- **block:** writing to credential files (`.credentials.json`, `auth.json`, `.env` of other projects), disabling sandbox, reading browser cookie/password stores.
- Codex has no per-tool callback in the SDK: Codex runs are sandboxed; outward actions must go through the Jarvis MCP `request_approval` tool (agents are instructed so in the context prefix), and the router sends tasks flagged `outward: true` to Claude.
- Approval cards show: what, why (agent's stated reason), exact command/payload, run link. Decide from web or Telegram. Pending approvals expire after 24 h (task → `needs_you`).

## 9. Memory (vault) — Phase 2a

Vault path from `JARVIS_VAULT` (owner's is `C:\Users\mukhe\Documents\AI-System`). Tests use `fixtures/vault`.

Target structure (Jarvis reads it; a one-time **migration proposal** helps the owner move to it — never auto-moves files):
```
CORE.md            always loaded, cap 2,000 tokens
Areas/             ongoing life/business areas
Projects/<name>.md current state only, cap 3,000 tokens each
People/<name>.md
Skills/<name>/SKILL.md   canonical shared skills
Research/          finished reports
Journal/DAILY/YYYY-MM-DD.md   cold, never preloaded
Inbox.md
```
Notes may have YAML frontmatter: `type, status, updated, tags, project, follow_up`.

- **Indexer:** walk vault on boot + `fs.watch` (debounced); parse frontmatter; estimate tokens (`chars/4`); upsert `notes_index` + `notes_fts`. Ignore `.obsidian`, `.trash`, binaries.
- **Context builder:** `CORE.md` + project note (if task has a project) + **skill descriptions only** (name + one line) + Jarvis MCP instructions. Enforce budget (`memory.contextBudgetTokens`, default 6,000); if over, truncate lowest-priority parts and flag it in the report. Agents fetch anything else on demand via MCP `search_memory` / `read_note`.
- **Context inspector:** for every run, UI shows exactly what was loaded and token counts.
- **Write-back:** agents call MCP `save_memory(target, content, reason)` → creates a `memory_proposal` (diff). Low-risk appends (daily log line, task result) apply automatically; edits to CORE/Projects/People need approval (batch-approvable).
- **Weekly consolidation (scheduled, Codex):** dedupe, remove stale facts, move history from Projects/* into Journal, enforce size caps. Produces proposals, never silent edits. Back up touched files to `data/backups/<date>/` before applying.
- **Size alerts:** Memory page flags files over cap.

## 10. Skills — Phase 2a

- Canonical skills live in `vault/Skills/<name>/SKILL.md` (frontmatter `name`, `description`).
- **Sync:** copy (not symlink — Windows) each enabled skill into `~/.claude/skills/<name>/` and `~/.codex/skills/<name>/`, tracking a manifest so Jarvis only manages skills it created. Dry-run mode in tests (target dirs configurable).
- **Connector skills:** templates for Gmail, Calendar, Drive, Browser describing preferences and rules (VIPs, labels, signature, what always needs approval). Never contain credentials.
- **Learning loop:** after a qualifying run, ask the same agent (resume its session, small prompt) to propose a reusable skill or an update to an existing one → `skill_proposals`. Owner approves/edits/rejects in UI.

## 11. Scheduler — Phase 2b

- `schedules` with cron (croner), timezone from system. Create from presets or raw cron; optional "describe in words" that converts via a single cheap Codex call (only on save, behind a button).
- Built-in (disabled until owner enables): **Morning brief** (weekdays 08:00: today's calendar, important unread email, due follow-ups, running/blocked tasks, usage), **Inbox triage**, **Weekly review** (Fri), **Memory consolidation** (Sun), **Updates digest** (daily).
- Missed runs while laptop was asleep: run once on wake if missed < 12 h, else skip and log.

## 12. Workspaces — Phase 3

- **Research:** task type `research` → agent with web search enabled → report written to `vault/Research/YYYY-MM-DD-<slug>.md` with a Sources section; follow-up questions resume the same session. Research page lists reports, searchable.
- **Updates feed:** `feed_sources` (RSS/Atom, GitHub `releases.atom`, plain pages via hash-diff). Fetched with plain `fetch` (no LLM) every N hours; daily digest task summarizes unseen items (Codex).
- **Code projects:** registry of local repos (path, remote). Shows `CLAUDE.md`/`AGENTS.md` presence and size, active Jarvis worktrees/branches, per-task diff stat, "open PR" (via `gh`, approval-gated), "clean up worktree".
- **People & clients:** from `People/*.md` frontmatter: last contact, open threads, `follow_up` due → shown on Home and in morning brief.

## 13. Jarvis MCP server (exposed to both agents)

Stdio MCP server started per run (`node server/src/mcp/stdio.ts --run <id>`), talking to the main server over localhost HTTP with a per-run token. Tools:
`create_task, update_task_status, search_memory, read_note, save_memory, request_approval, notify_owner, list_projects, get_usage`.
Registered via Claude SDK `mcpServers` and Codex config overrides (verify the Codex SDK's mechanism; fall back to writing a per-run `CODEX_HOME` overlay only if needed — never edit the owner's global `~/.codex/config.toml`).

## 14. Usage meter

- **Run totals:** tokens from each SDK's final usage event → `runs`.
- **Plan windows:**
  - Codex: session JSONL under `~/.codex/sessions/**` contains `token_count` events with `rate_limits` (`primary` ≈ 5-hour, `secondary` ≈ weekly, each with `used_percent` and reset time). Read the newest event → `usage_snapshots`.
  - Claude: Claude Code's own /usage data from a prompt-free SDK session (source `claude-usage`) every 5 minutes, plus `claude-sdk` readings during runs. Transcript estimates and soft caps were removed.
- Poll Codex session logs at the configured interval (only files modified since last poll). Overview shows two bars per agent (5 h, weekly) with reset times; missing windows say "Not reported yet".

## 15. API (selection)

```
GET  /api/health
GET  /api/stream                      SSE: task/run/approval/usage events
GET  /api/tasks?status=&type=&project=   POST /api/tasks   PATCH /api/tasks/:id
POST /api/tasks/:id/run   POST /api/tasks/:id/cancel   POST /api/tasks/:id/followup
GET  /api/runs/:id   GET /api/runs/:id/events
GET  /api/approvals?status=pending   POST /api/approvals/:id {decision}
GET  /api/usage
GET  /api/memory/search?q=   GET /api/memory/note?path=   GET /api/memory/proposals   POST /api/memory/proposals/:id
GET  /api/skills   POST /api/skills/sync   GET/POST /api/skills/proposals
GET/POST/PATCH /api/schedules   POST /api/schedules/:id/run-now
GET  /api/research   GET/POST /api/feeds   GET /api/feeds/items
GET/POST /api/projects   GET /api/people
GET/PUT  /api/settings
```

## 16. Web UI pages

Mobile-first; bottom nav on phone, sidebar on desktop. Every text input has a mic button (Web Speech API dictation; hidden if unsupported).
1. **Home** — command bar; Needs you (approvals + blocked); Running now (live); usage bars; today's schedule; due follow-ups.
2. **Board** — Inbox / Queued / Running / Needs you / Done; filters (project, type, agent); drag to change status; quick "run with Claude/Codex".
3. **Run view** — live transcript, tool calls (collapsible), file changes, context report, tokens; Stop / Follow-up / Resume.
4. **Approvals** — queue with approve/reject + note.
5. **Usage** — per-agent windows, per-day and per-task-type token charts, routing decisions log.
6. **Memory** — search, note viewer, size-cap warnings, proposals (diff approve), migration proposal.
7. **Skills** — list, enable/disable, sync status, proposals.
8. **Schedules** — list, presets, run now, history.
9. **Research** — reports list + reader.
10. **Updates** — feed items, sources.
11. **Projects** — code + client projects, worktrees, PR actions.
12. **People** — follow-ups.
13. **Settings** — router rules, concurrency, vault path, Telegram, access token, budgets.

## 17. Telegram (optional, Phase 3)

`TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALLOWED_CHAT_ID` in `.env`. Ignore all other chats.
- Any text → new task (reply with routed agent + link). `/status`, `/tasks`, `/usage`, `/cancel <id>`.
- Notifications: approval requests (inline Approve/Reject buttons), task done/failed (summary), morning brief.

## 18. Phases & acceptance

**Phase 1 — Foundation**
- `npm install && npm run dev` starts server + web; `npm test` green with mock runner.
- Create task from UI/API → routed → mock run streams events live → done; cancel works; follow-up works.
- Claude and Codex runners implemented against real SDK types and covered by unit tests with the SDK mocked; a manual script `npm run smoke:claude` / `smoke:codex` performs one tiny real run (owner runs locally).
- Concurrency limit + queue; approvals pause/resume a mock run; usage meter parses fixture JSONL for both agents; router fallback tested.
- Board, Run view, Approvals, Usage, Settings pages work on phone width.

**Phase 2a — Memory & Skills:** indexer + FTS on fixture vault; context builder with budget + report; MCP `search_memory/read_note/save_memory`; proposals with diff approval; migration proposal generator; skills registry + sync (dry-run in tests) + learning-loop proposals.

**Phase 2b — Scheduler:** cron schedules, presets, run-now, missed-run handling, built-in routines (disabled by default).

**Phase 3 — Workspaces & Telegram:** research reports to vault; feeds fetch + digest; code projects with worktrees + approval-gated PR; people follow-ups; Telegram bot with approvals.

**Phase 4 — Later (not now):** run on a small VPS, desktop computer-use tasks.

## 19. Non-goals
Own LLM hosting, vector DB, cloud/paid voice services, multi-user, agent swarms, replacing the Claude Code / Codex chat UIs for interactive coding.
