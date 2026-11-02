# Jarvis — Design system

The bar: it should feel like a premium, focused tool (think Linear, Raycast, Things) — calm, dense, fast, precise. **No AI slop.** If a choice looks like a default template, it's wrong.

## Direction (updated on the owner's request: "sci-fi Jarvis", premium, both themes perfect)
Dark mode is a **Stark HUD**: near-black navy, a faint 32px blueprint grid, hairline panels with accent corner ticks, mono uppercase telemetry labels, and arc-reactor cyan as the single interactive accent. It should feel like a precision instrument (Linear/Raycast density, X "lights out" contrast), not a movie prop: glow only on live/focused things, never decorative.
Light mode is **Lab**: cool paper whites, ink text, the same structure with no grid and no glow.

## Banned
- Purple/blue "AI" gradients, sparkle ✨ icons, robot/brain illustrations, stock art.
- Glassmorphism panels, heavy drop shadows, neon outlines everywhere, rainbow charts, scanline/glitch effects.
- Emoji as icons. Lorem ipsum. "Welcome to Jarvis 👋" banners.
- Cards inside cards. Giant rounded pills everywhere.
- Default browser form controls, unstyled scrollbars, layout shift on load.
- Generic copy ("Something went wrong", "No data"). Every empty/error state says what happened and what to do next.

## Tokens (`web/src/styles/tokens.css`; HUD layer in `hud.css`)

Dark (default, "Stark HUD"):
```
--bg #05080D  --bg-raised #0A1119  --bg-sunken #03060A  --bg-hover #0F1924
--border rgba(125,211,252,.10)  --border-strong rgba(125,211,252,.20)
--text #E4EEF7  --text-muted #93A7B9  --text-faint #71869A
--accent #3CCFFF (arc reactor)  --accent-ink #021019
--warning #F5B544 (approvals / needs you)  --success #3DDC97  --danger #FF6170  --info #7AA2FF
--agent-claude #F08A5D  --agent-codex #B7A5FF
--glow 0 0 0 1px rgba(60,207,255,.35), 0 0 24px rgba(60,207,255,.18)   (live + focus only)
```
Light ("Lab"): `--bg #F4F7FA`, `--bg-raised #FFFFFF`, `--border #DDE5EC`, `--text #0B1620`, `--text-muted #4B5C6C`, `--accent #0A86B8` (AA on white), agents `#B24E24` / `#6A52C9`. All text ≥ 4.5:1.

Type: **Geist** (UI) and **Geist Mono** (IDs, tokens, timestamps, commands, telemetry labels) — self-hosted. Scale 11 / 12 / 13 / 14 (base) / 16 / 20 / 22 / 28. Section and panel labels: mono 11px, uppercase, 0.12em tracking, with a small diamond marker. Tabular numbers for all metrics.

Space: 4px grid. Radius: 6 (controls), 10 (panels), 999 only for dots. Shadows only on overlays.

Motion: 120–180 ms, `cubic-bezier(.2,.8,.2,1)`, opacity/transform only; the reactor's outer tick ring rotates once per 24 s; live dots pulse. All of it off under `prefers-reduced-motion`.

Signature elements: the **reactor** (concentric arcs = Claude/Codex 5 h + weekly usage, centre = active runs) and the **telemetry strip** on Home; corner ticks on panels; "› ASK JARVIS" command bar.

Icons: `lucide-react`, 16px, 1.5 stroke, `currentColor`.

## Layout
- Desktop (≥ 1024): 232px sidebar (sections: Home, Board, Approvals, Research, Updates, Projects, People, Memory, Skills, Schedules, Usage, Settings — with counts for Needs-you/Approvals), content max-width 1200, optional right detail pane (run view opens as a pane from the Board).
- Mobile (< 768): bottom tab bar (Home, Board, **+ capture**, Approvals, More), 16px gutters, no horizontal scroll at 375px, tap targets ≥ 44px, sheets instead of side panes.
- **Command palette** (Ctrl/Cmd+K): create task, jump to page/task/note, run schedule, switch theme. Keyboard shortcuts: `c` new task, `g b` board, `g a` approvals, `/` search, `j/k` list navigation, `Esc` close.

## Key components
- **Command bar** (Home top): single large input, placeholder rotates real examples ("Research the best Postgres backup tools", "Fix the login bug in ClientEasy"); shows predicted type, project and agent chips before submit; mic button for dictation; Enter to create, Shift+Enter newline.
- **Agent badge**: small dot + name in agent colour (`Claude`, `Codex`). Routing reason on hover/tap.
- **Status**: dot + label; `running` dot pulses. Consistent everywhere.
- **Usage meter**: per agent two thin bars (5 h, weekly), percent in mono, "resets in 2h 14m". Bar turns warning at 70%, danger at 85% (the router fallback threshold, marked on the bar).
- **Run transcript**: messages in plain text column; tool calls as compact one-line rows (icon, tool, target, duration) that expand to show input/output in mono on `--bg-sunken`; file changes with +/− counts; sticky footer with Stop / Follow-up input.
- **Approval card**: what will happen in one sentence, exact command/payload in mono, agent + task link, Approve (accent) / Reject (ghost) — the only place two primary-weight buttons sit side by side.
- **Board**: columns as lists, not heavy cards; rows show title, project, agent badge, age; drag-and-drop with keyboard alternative.
- **Context inspector**: table of loaded files with token counts and a stacked bar against the budget.
- **Empty states**: one line of what this is + one primary action. **Skeletons** match final layout. **Toasts** bottom-right (desktop) / top (mobile), auto-dismiss 4s, undo where possible.

## Charts
Usage charts: thin lines/bars, agent colours only, no gridline clutter, mono axis labels, hover tooltip with exact numbers. No pie charts.

## Quality gate (every PR touching UI)
- Screenshots of each changed page at 375×812 and 1440×900, dark and light, attached to the PR (Playwright, dev-only dependency).
- No console errors. Lighthouse accessibility ≥ 95. Visible focus on every interactive element.
- Real-looking seed data in mock mode (believable task titles, projects, usage) — never "Test task 1".
