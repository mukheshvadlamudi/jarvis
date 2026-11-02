# Jarvis — rules for agents building this repo

Read `SPEC.md` first. It is the source of truth for what to build; this file is how to build it.

## Must
- Node 24, TypeScript run via Node type stripping: **no enums, namespaces, or constructor parameter properties**. Use `import type` for types. Run `npm run typecheck` before committing.
- No native npm modules. Database is `node:sqlite`. Keep dependencies few and small; justify any new one in the PR description.
- All agent-SDK code lives in `server/src/runners/`. Before writing it, read the installed `.d.ts` files of `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk` — do not rely on memory or on the spec for exact signatures.
- Tests use `JARVIS_RUNNER=mock`. Never make real Claude/Codex calls in tests or in cloud sessions — there are no plan logins there, and there must never be.
- Strip `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `CODEX_API_KEY` from every spawned agent's environment.
- Always pass an explicit Codex sandbox mode; never inherit the global config.
- Use `fixtures/vault` for anything that reads the vault. Never hard-code the owner's real paths outside `.env.example` comments.
- Server binds `127.0.0.1` unless `JARVIS_BIND` and `JARVIS_ACCESS_TOKEN` are both set.
- Keep the server light: no polling loops faster than needed, stream large logs instead of buffering, cap stored event payloads (truncate tool output > 20 KB, keep a note that it was truncated).
- UI must work at 375 px width with no horizontal scroll, and in light and dark mode.

## Workflow
- Stay inside the modules your phase owns (SPEC §3 "Module ownership"). Register routes in `server/src/api/register.ts` and pages in `web/src/routes.ts` with one line each, to keep parallel branches mergeable.
- Small commits with clear messages. Work on a branch and open a PR describing what was built, what was tested, and anything stubbed.
- `npm test` and `npm run typecheck` must pass before opening the PR.
- If the spec is ambiguous, pick the simplest option that keeps the constraints, and note it in `docs/decisions.md`.

## Don't
- Don't add API-key based providers, OpenRouter, LangChain, vector stores, Docker, or Electron.
- Don't write to `~/.claude` or `~/.codex` except through the skills sync (which must support a dry-run target dir) and never touch their credential files.
- Don't commit `.env`, `data/`, or anything from a real vault.
