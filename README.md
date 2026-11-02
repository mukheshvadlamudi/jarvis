# Jarvis

Personal command centre that runs your work — coding, research, email/admin, updates, routines — through the official **Claude Code** and **Codex** agents on your existing **Claude Pro** and **ChatGPT Plus** plans. No API keys, ever.

See [SPEC.md](SPEC.md) for the design, [docs/DESIGN.md](docs/DESIGN.md) for the UI system and [docs/decisions.md](docs/decisions.md) for choices made while building. Build rules for agents are in [CLAUDE.md](CLAUDE.md). Screenshots of every page (phone and desktop, dark and light) are in [docs/screenshots](docs/screenshots).

## Requirements
- Node 24+ and git
- A Claude Pro/Max and a ChatGPT Plus/Pro subscription (the Claude Code and Codex CLIs ship inside Jarvis — just log in once)
- Optional: `gh` CLI (for approval-gated "Open PR"), a Telegram bot

Jarvis removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY` and `CODEX_API_KEY` from every agent it starts, so usage always comes from your plans.

## Desktop app
Download the installer for Windows, macOS or Linux from **Releases** (or the latest *Desktop app* Actions run) and open **Jarvis** — no Node install needed. It lives in the tray, sends native notifications for approvals, and `Ctrl+Shift+J` captures a task from anywhere. Run it from source with `npm run desktop`; build installers with `npm run package:win|mac|linux`. Details: [docs/INSTALL.md](docs/INSTALL.md).

## Run (one click, from source)
- **Windows:** double-click `start-jarvis.cmd` · **macOS:** `start-jarvis.command` · **Linux:** `./start-jarvis.sh`
- Or `npm run app` (add `--demo`, or `npm run demo`, to try it without your plans).

The launcher installs and builds on first run, offers the Claude/Codex logins (`npm run login:claude`, `npm run login:codex`), starts Jarvis and opens the **Setup** page, which connects your vault, code folders, skills, routines and Telegram. Then install it as an app from the browser. Full guide for you or anyone you share it with: [docs/INSTALL.md](docs/INSTALL.md).

Manual: `npm install && cp .env.example .env && npm start`.
Development (hot reload): `npm run dev` → API on :4317, UI on http://127.0.0.1:5173.

Try everything without touching your plans: `JARVIS_RUNNER=mock` gives scripted runs plus believable demo data (a copy of `fixtures/vault`, a demo git repo, feeds, schedules, approvals).

## First run checklist (real logins)
1. `npm run smoke:claude` and `npm run smoke:codex` — one tiny read-only run each; prints session, tokens and plan-usage readings.
2. Memory → Health: review the migration proposal for your vault (Jarvis never moves files).
3. Skills → Preview sync, then Sync now (copies to `~/.claude/skills` and `~/.codex/skills`; only skills Jarvis created are ever touched).
4. Projects → add your repos (local path) so coding tasks run in `.jarvis-worktrees/<task>`.
5. Schedules → turn on the Morning brief when you're happy.
6. Optional: Telegram (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_ID`, `JARVIS_PUBLIC_URL`).
7. Optional remote access (phone over Tailscale): set both `JARVIS_BIND` and `JARVIS_ACCESS_TOKEN`.

## What's inside
| Page | What it does |
|---|---|
| Home | Command bar (dictation, live type/project/agent preview), Needs you, Running now, plan usage, today's routines, follow-ups |
| Board | Inbox → Queued → Running → Needs you → Done; drag or `[`/`]`; run with Claude or Codex |
| Run view | Live transcript, tool calls, file changes, consults between agents, context inspector, tokens; Outputs panel (preview, download, save to vault); hand off to the other agent for review or to continue; Stop / follow-up / run again |
| Approvals | Everything outward-facing waits here (and in Telegram) |
| Research | Reports saved to `Research/` with sources; follow-ups continue the same session |
| Updates | RSS/Atom/GitHub releases and page-change feeds; daily digest |
| Projects | Repos, CLAUDE.md/AGENTS.md, Jarvis worktrees with diff stats, approval-gated PRs, clean-up |
| People | Follow-ups and open threads from `People/*.md` |
| Memory | Vault search and reader, memory proposals with diffs, size caps, migration proposal |
| Skills | Vault skills, sync to Claude/Codex, agent-proposed skills |
| Schedules | Cron schedules and built-in routines with missed-run catch-up |
| Usage | Plan windows, per-day/per-type tokens, routing decisions |
| Settings | Routing rules, agent model and reasoning effort, collaboration, concurrency, budgets, voice, Telegram, theme |
| Voice | Hands-free: say “Jarvis, …”. Kokoro speaks approvals and results, Whisper listens. All on your device, no credits |

**Agents use their own harnesses.** Claude tasks run in the real Claude Code (via the Claude Agent SDK), and Codex tasks run in the real Codex CLI (via the Codex SDK). Each keeps its own tools, project instructions and skills. Jarvis only routes the work, adds memory context, enforces approvals, and lets the two agents consult each other or hand work off.

## Tests
```
npm test            # server + web, always with JARVIS_RUNNER=mock (no real agent calls)
npm run typecheck
npm run build && node web/scripts/screenshots.mjs   # UI quality gate
```

## Keyboard
`Ctrl/⌘ K` palette · `c` new task · `/` search · `g` then `h b a e n p o m s r u ,` to jump · `j`/`k` move · `[`/`]` move a board card · `Esc` close.
