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
