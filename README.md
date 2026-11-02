# Jarvis

Personal command centre that runs tasks through the official Claude Code and Codex agents on your existing Claude Pro and ChatGPT Plus plans.

See [SPEC.md](SPEC.md) for the design. Build rules for agents are in [CLAUDE.md](CLAUDE.md).

## Requirements
- Node 24+
- `claude` CLI logged in with your Claude plan (`claude` → `/login`)
- `codex` CLI logged in with ChatGPT (`codex login`)
- No API keys: Jarvis removes them from agent environments so usage always comes from your plans.

## Run
```
npm install
cp .env.example .env
npm run dev
```
Open http://127.0.0.1:4317
