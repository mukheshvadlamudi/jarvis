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

## Phase 3 — Workspaces & Telegram

28. **Research runs `workspace-write` in their scratch folder** (changes decision 4) so the agent can write `report.md`; live web search and network are on. The report is saved to `Research/YYYY-MM-DD-<slug>.md` with frontmatter (`type, updated, task, agent, project`) and a guaranteed `## Sources` section. Follow-ups resume the same session and rewrite the same note (`task.output_path`).
29. **Feeds** use a tolerant regex reader for RSS 2.0 and Atom (incl. GitHub `releases.atom`) — no XML dependency. Other URLs are "pages": the visible text is hashed and a change creates one item. Fetching is plain HTTP every `feeds.fetchEveryHours`; mock mode never fetches automatically (set `JARVIS_FEEDS_FETCH=1`). Items are marked seen when an Updates-digest run finishes.
30. **Open PR is approval-gated as a Jarvis action**, not an agent action: approving runs `git push -u origin <branch>` and `gh pr create --head <branch> --fill` in the worktree, stores the PR URL on the task and notifies. Rejecting does nothing. Approval handlers are registered per action (`approvals.actions`) so they don't resume an agent session.
31. **Worktree clean-up** removes only the worktree folder and keeps the branch; refuses while the task runs; dirty worktrees need an explicit "remove anyway".
32. **People** are read from `People/*.md` frontmatter (`company, role, email, last_contact, follow_up, tags`) plus an "Open threads" list in the body. "Contacted today", "Snooze a week" and the date picker rewrite only those frontmatter lines (owner action → applied immediately, previous version backed up).
33. **Telegram** uses plain `fetch` long polling (`getUpdates`, 50 s) and answers only `TELEGRAM_ALLOWED_CHAT_ID`. Links in messages use `JARVIS_PUBLIC_URL` (e.g. your Tailscale URL) or fall back to localhost. The morning brief is sent in full; other finished tasks as a short summary. Settings → `telegram.enabled` turns it on/off without a restart.
34. **Mock-mode demo repo:** seeding creates `data/demo-repos/clienteasy` (a real git repo with a Jarvis worktree and commit) so the Projects page shows real worktree/diff data.

## Follow-up — Jarvis HUD theme, setup and distribution

35. **Design direction changed at the owner's request** to a sci-fi "Stark HUD" dark theme (arc-reactor cyan accent, blueprint grid, corner ticks, mono telemetry labels, reactor gauge) and a clean "Lab" light theme. `docs/DESIGN.md` is updated; amber stays the "needs you" colour.
36. **No Electron** (superseded by 39) (CLAUDE.md forbids it; ~200–300 MB extra RAM). Jarvis ships as a local server + installable PWA, started by a one-click launcher (`start-jarvis.cmd` / `.command` / `.sh` → `scripts/jarvis.mjs`) that installs, builds, offers logins, opens the browser and restarts on exit code 75. A Tauri shell is the suggested path if a signed installer is ever required.
37. **Logins use the CLIs bundled in our dependencies** (`@anthropic-ai/claude-agent-sdk-<platform>` binary, `@openai/codex`), via `npm run login:claude|codex`, with API-key variables removed. Login detection only checks that the CLI's credential file exists (macOS Claude uses the Keychain, so it is reported as "verify"); Jarvis never reads those files. "Verify" makes one tiny real run, only on button press and never in mock mode.
38. **Setup choices persist in `data/local-env.json`** (vault path, Telegram) and override `.env` at the next start, so non-technical users never edit files. Applying them needs a restart (one click under the launcher).
39. **Desktop app (Electron) added at the owner's request**, overriding the earlier "no Electron" rule (CLAUDE.md updated). `desktop/` is a thin shell: it runs the unchanged Jarvis server on Electron's bundled Node 24 (`ELECTRON_RUN_AS_NODE`), so users need no Node install. It adds a tray (closing the window keeps routines running), Ctrl+Shift+J capture, native notifications for approvals and finished tasks, start-at-login, one-click Claude/Codex login terminals, and a splash. If a Jarvis server is already running on the port, the app attaches to it instead of starting a second one. Security: context isolation, sandboxed renderer, a minimal preload bridge, and external links open in the browser.
40. **Packaging** stages server source + built UI + production dependencies installed for the *target* OS/CPU (`npm install --os --cpu`), so a Windows build contains the Windows Claude Code/Codex binaries. Installers are big (~450–500 MB) because both agent CLIs ship inside. Windows NSIS installers need Windows (or Wine), so `.github/workflows/desktop.yml` builds Windows, macOS (unsigned) and Linux on native runners, uploads artifacts on every relevant push, and publishes a Release for `v*` tags.
41. **Desktop data** lives in the per-user app-data folder (`%APPDATA%\Jarvis\data` on Windows) with an optional `.env` beside it; when run from the repo, the desktop app uses the repo's `data/` and `.env` like the launcher.
