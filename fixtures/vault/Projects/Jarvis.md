---
type: project
status: active
updated: 2026-11-02
tags: [personal, tooling]
project: Jarvis
repo: github.com/mukheshvadlamudi/jarvis
---
# Jarvis

Personal command centre: runs my tasks through Claude Code and Codex on my plans, approval-gated, with this vault as memory.

## Current state
- Phase 1 (foundation) built in the cloud; I test real runs locally.
- Next: memory + skills, then scheduler (morning brief), then Telegram.

## Constraints
- 8 GB laptop: server under 150 MB, max 2 agents at once.
- No API keys, ever. Plan logins only.

## Open questions
- Where to back up `data/jarvis.db` — Backblaze B2 or Hetzner Storage Box?
