---
type: project
status: active
updated: 2026-11-01
tags: [product, typescript, saas]
project: ClientEasy
repo: github.com/mukhesh/clienteasy
---
# ClientEasy

Client booking and invoicing for small clinics. ~40 paying clinics, mostly dental and physio in the UK.

## Stack
- TypeScript everywhere. API: Node 22 + Fastify, Postgres 16 (Hetzner managed), Drizzle ORM.
- Web: React + Vite, Tailwind (legacy — new screens use CSS modules).
- Jobs: moved from cron script to a job queue (pg-boss) in Oct; reminders now retry.
- Tests: Vitest (unit + API), Playwright for booking flow smoke tests.
- Deploy: GitHub Actions → Docker image → Hetzner CX32. Staging at staging.clienteasy.example.

## Current state (Nov 2026)
- 2.4 released 29 Oct (release notes in docs/releases/2.4.md).
- 2.5 in progress, target 20 Nov:
  - CSV export on the invoices page (not started).
  - Reminder queue hardening: idempotency keys, dead-letter view (half done).
  - Flaky date-picker test in `booking/DatePicker.test.tsx` — fails ~1 in 15 runs on CI, timezone related.
- Token refresh race in `src/auth/session.ts` fixed on branch `jarvis/t_3fq-token-refresh` — needs PR.

## Conventions
- Branches: `feat/…`, `fix/…`; Jarvis uses `jarvis/<task>-<slug>`.
- Every PR: tests + a line in CHANGELOG.md under "Unreleased".
- Database migrations are additive only; destructive changes need a two-step deploy.
- Never run migrations against production from a laptop.

## Known issues
- Safari login loop (#212) when third-party cookies are blocked — workaround in place, proper fix in 2.6.
- Invoice PDF fonts fall back to Helvetica on the server; low priority.

## Contacts
- Support inbox: support@clienteasy.example (shared with no one else yet).
- Beta clinics for new features: Northwind Dental, Riverside Physio.

## Decisions
- 2026-09: stay on Postgres managed by Hetzner rather than self-hosting.
- 2026-10: pg-boss over BullMQ (no Redis on the box).
