# Jarvis

Personal command centre that runs tasks through the official Claude Code and Codex agents on your existing Claude Pro and ChatGPT Plus plans.

See [SPEC.md](SPEC.md) for the design, [docs/DESIGN.md](docs/DESIGN.md) for the UI system and [docs/decisions.md](docs/decisions.md) for choices made while building. Build rules for agents are in [CLAUDE.md](CLAUDE.md).

## Requirements
- Node 24+
- `claude` CLI logged in with your Claude plan (`claude` → `/login`)
- `codex` CLI logged in with ChatGPT (`codex login`)
- No API keys: Jarvis removes them from agent environments so usage always comes from your plans.

## Run
```
npm install
cp .env.example .env      # set JARVIS_VAULT to your Obsidian vault
npm start                 # builds the UI and serves http://127.0.0.1:4317
```
Development (hot reload): `npm run dev` → API on :4317, UI on http://127.0.0.1:5173.

Try it without touching your plans: set `JARVIS_RUNNER=mock` — scripted runs plus believable demo data.

## Check your logins (local only)
```
npm run smoke:claude
npm run smoke:codex
```
Each makes one tiny read-only run and prints the events, session id, tokens and plan-usage readings.

## Tests
```
npm test            # server + web, always with JARVIS_RUNNER=mock
npm run typecheck
node web/scripts/screenshots.mjs   # UI quality gate (needs `npm run build` first)
```

## Keyboard
`Ctrl/⌘ K` palette · `c` new task · `/` search · `g h|b|a|u` go to Home/Board/Approvals/Usage · `j`/`k` move · `[`/`]` move a board card · `Esc` close.
