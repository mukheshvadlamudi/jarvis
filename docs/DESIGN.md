# Jarvis — Design system

The bar: it should feel like a premium, focused tool (think Linear, Raycast, Things) — calm, dense, fast, precise. **No AI slop.** If a choice looks like a default template, it's wrong.

## Banned
- Purple/blue "AI" gradients, glowing orbs, sparkle ✨ icons, robot/brain illustrations.
- Glassmorphism, heavy drop shadows, neon, rainbow charts.
- Emoji as icons. Stock illustrations. Lorem ipsum. "Welcome to Jarvis 👋" hero banners.
- Cards inside cards. Every element in its own bordered box. Giant rounded pills everywhere.
- Default browser form controls, unstyled scrollbars, layout shift on load.
- Generic copy ("Something went wrong", "No data"). Every empty/error state says what happened and what to do next.

## Character
A **command centre at night**: dark-first, warm graphite neutrals, one precise accent, monospace for machine data. Information-dense but breathing. Motion is quick and purposeful, never decorative.

## Tokens (define as CSS custom properties on `:root`, light variant under `[data-theme="light"]` and `prefers-color-scheme`)

Colour — dark (default):
```
--bg:            #0E0F11   page
--bg-raised:     #151619   panels, sidebar
--bg-sunken:     #0A0B0C   inputs, code, transcript
--bg-hover:      #1C1D21
--border:        #24262B   hairlines (1px)
--border-strong: #33363D
--text:          #ECECEE
--text-muted:    #9A9CA3
--text-faint:    #64666D
--accent:        #E8A55A   amber — focus rings, primary action, active nav, live indicators
--accent-ink:    #1A1206   text on accent
--success:       #5FB98A
--warning:       #E2B24A
--danger:        #E5675B
--info:          #6FA3D8
--agent-claude:  #D97757   warm clay
--agent-codex:   #5BB5A2   cool teal
```
Light: `--bg #FAFAF9`, `--bg-raised #FFFFFF`, `--bg-sunken #F3F3F1`, `--border #E6E5E1`, `--text #16171A`, `--text-muted #5E6068`, `--accent #C27A2C` (keep contrast ≥ 4.5:1 for text, ≥ 3:1 for UI).

Type: **Geist** (UI) and **Geist Mono** (IDs, tokens, timestamps, commands, code) — self-hosted from the `geist` npm package, no font CDN. Scale: 12 / 13 / 14 (base) / 16 / 20 / 28. Weights 400/500/600 only. Tabular numbers for all metrics (`font-variant-numeric: tabular-nums`). Letter-spacing −0.01em on ≥20px.

Space: 4px grid (4, 8, 12, 16, 24, 32, 48). Radius: 6 (controls), 10 (panels), 999 only for status dots. Shadows: only for overlays (palette, menus, toasts): `0 12px 32px rgba(0,0,0,.45)` + 1px border.

Motion: 120–180 ms, `cubic-bezier(.2,.8,.2,1)`. Animate opacity/transform only. Respect `prefers-reduced-motion`. Live runs: a subtle pulsing 6px accent dot, nothing else animated.

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
