# Decisions

Ambiguities in SPEC.md resolved with the simplest option that keeps the constraints.

## Phase 1 — Foundation

1. **Extra task columns.** `tasks` gains `outward` (task acts outside the machine), `route_reason` (shown in the UI) and `not_before` (held until a plan window resets). `runs` gains `route_reason` and `prompt` (the follow-up text that started the run). `approvals` gains `note`.
2. **Explicit agent choice is respected under load.** SPEC §6 applies the usage fallback after every rule. If you explicitly picked an agent, or the task is outward-facing (needs Claude's per-tool approvals), Jarvis waits for that agent's reset instead of silently switching. Auto-routed tasks fall back as specified.
3. **Claude approvals are enforced twice.** A `PreToolUse` hook returns `ask`/`deny` for every risky call, even if your own Claude settings allow it; `canUseTool` then waits for your decision. Read-only tasks deny Write/Edit tools.
4. **Codex sandbox per task type.** `research`, `admin` and `update` tasks run `read-only`; everything else `workspace-write`. `approvalPolicy: 'never'` (Codex can't ask mid-run; outward actions go through the Jarvis MCP `request_approval` tool). Network is off for code tasks unless the task is outward.
5. **Approvals without a live run** (Codex MCP requests, or a run that ended/restarted) resume the task's last session with "the owner approved X" when approved.
6. **Claude rate-limit utilisation** from the SDK's `rate_limit_event` is treated as a fraction when ≤ 1, otherwise as a percent. The shipped `.d.ts` does not state the unit — verify with a real run (logged by `npm run smoke:claude`).
7. **Claude usage estimate** weights tokens as input + output + cache-creation + 10% of cache-reads, against owner-configurable soft caps (defaults 3M / 5 h, 40M / week). Always labelled "estimate"; live SDK readings take precedence while their window is open.
8. **Interrupted runs** (server stopped mid-run) are marked failed on boot with a clear summary; a follow-up resumes the saved session.
9. **Follow-ups**: mock runs accept them live; Claude/Codex runs resume the session in a new run after the current one ends (simpler and more robust than streaming input mode).
10. **No MCP SDK dependency** — the Jarvis MCP server (Phase 2a) is a small JSON-RPC stdio implementation.
11. **Dev URLs**: `npm run dev` serves the API on :4317 and the UI with hot reload on :5173 (proxying `/api`). `npm start` builds the UI and serves everything on :4317.
12. **Mock mode seeds demo data** on an empty database (disable with `JARVIS_SEED=0`) and reads usage fixtures from `fixtures/usage/`.

## Phase 2a — Memory & Skills

13. **Mock mode works on a copy of the vault.** When `JARVIS_VAULT` points at `fixtures/vault`, Jarvis copies it to `data/demo-vault` and writes there, so the fixtures (and tests) are never modified.
14. **Auto-apply rules for `save_memory`:** appends to `Journal/`, `Inbox.md` and `Research/` apply immediately; any change to `CORE.md`, `Projects/`, `People/` or `Areas/`, and any full rewrite outside `Research/`, waits for approval. Skills cannot be edited through `save_memory` (only through skill proposals).
15. **Backups** are taken for owner-approved changes (`data/backups/<date>/<path>`, first version of the day kept). Rewrite proposals fail safely if the note changed after the proposal was made.
16. **FTS5** uses `porter unicode61` with prefix matching and bm25 (title weighted 8×). A plain `notes_body` table backs the `LIKE` fallback.
17. **Context trimming order:** skill list → project note → CORE.md; Jarvis instructions are never trimmed. Over-budget parts are cut at a line boundary with a note telling the agent to use `read_note`.
18. **Learning loop** runs as a recorded "side run" (visible in the task's runs, counts toward usage) resuming the same session, read-only, with approvals refused. One learning step at a time; it does not take a concurrency slot. Only runs that finished `done` with ≥ `learning.minToolCalls` tool calls qualify.
19. **Skills sync** copies `Skills/<name>/` into `~/.claude/skills/<name>` and `~/.codex/skills/<name>` with a `.jarvis-manifest.json` per target; same-named skills Jarvis didn't create are skipped, never overwritten. Mock mode targets `data/skills-dry-run/*`. Sync runs on demand (Skills page) and after approving a skill proposal.
20. **Jarvis MCP server** is a dependency-free stdio JSON-RPC bridge (`server/src/mcp/stdio.ts`) that forwards to `POST /api/mcp/call` with a per-run token (revoked when the run ends). `request_approval` waits up to 10 minutes, then returns `PENDING`; approving later resumes the session. A run that ends with a pending approval leaves the task in "Needs you".
21. **Codex MCP registration** uses the SDK's `config` option (`--config mcp_servers.jarvis.*`), so the owner's `~/.codex/config.toml` is never edited and no `CODEX_HOME` overlay is needed.

## Phase 2b — Scheduler

22. **Schedules create tasks.** Each firing creates a normal task (`schedule_id` set, title suffixed with the date) so it is routed (`scheduled ⇒ router.scheduledTasks`, Codex by default), visible on the Board and reviewable like any other run.
23. **Built-in routines build their prompt at fire time** from live Jarvis state (open tasks, plan usage, follow-ups from People/Projects frontmatter, unseen feed items) instead of a static template. All five ship disabled.
24. **Missed runs:** checked at boot and on wake (a 1-minute heartbeat that arrives > 3 minutes late means the laptop slept). For each enabled schedule, the most recent due time after its last run (or enable time) runs once if < 12 h late; otherwise it is logged as skipped. Never more than one catch-up per schedule.
25. **“Describe in words”** tries local rules first (weekdays/weekends/named days/daily/every N hours/monthly) and only then makes one small read-only Codex call — only when the owner presses Convert. The result is always validated with croner before use.
26. **Timezone** is the system timezone (croner default); shown on the Schedules page.
27. **Home “Follow-ups”** shows anything with `follow_up` due within 7 days (overdue highlighted); the morning brief lists only those due today or earlier.
