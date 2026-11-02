# Jarvis — Design system

The bar: it should feel like a premium, focused tool (think Linear, Raycast, Things) — calm, dense, fast, precise. **No AI slop.** If a choice looks like a default template, it's wrong.

## Direction (unslopped Nov 2026: the owner asked for a premium Jarvis look using the unslop skill)
Before calling any UI work done, run `.claude/skills/unslop` (by Damir Sokolovsky, @heydamir, CC BY 4.0) on the screen and keep to its checklist.

- **Product.** A control room on the owner's PC that runs their Claude and ChatGPT plans as agents on their tasks, and asks before anything leaves the machine.
- **Character.** Calm, exact, on watch.
- **World.** Stark's workshop at night: an instrument panel in dark glass with one arc-reactor light. The light means an agent is doing something right now.
- **Moments.** The reactor core on Home (real plan usage on a dial) and the live run transcript. Everything else is quiet chrome.
- **Signature.** The lamp: a cyan dot lit only while an agent is working (sidebar status, Home status line, running rows, reactor core).

Dark is the default ("workshop at night"). Light is **Lab**: neutral paper whites, ink text, the same structure.

## Banned
- Purple/blue "AI" gradients, gradient text, sparkle ✨ icons, robot/brain illustrations, stock art.
- Any glow or coloured shadow, background grids, radial washes, panel sheens, corner ticks, diamond markers, neon outlines, glass, scanline/glitch effects, rainbow charts.
- Uppercase tracked labels: section labels are sentence case.
- Looping motion on anything that isn't live. The reactor dial turns only while an agent runs.
- Emoji as icons. Lorem ipsum. Greeting headlines ("Good evening", "Welcome to Jarvis 👋"). Exclamation marks. Trailing periods on titles, labels and buttons.
- Cards inside cards. Giant rounded pills everywhere.
- Default browser form controls, unstyled scrollbars, layout shift on load.
- Generic copy ("Something went wrong", "No data"). Every empty/error state says what happened and what to do next.

## Tokens (`web/src/styles/tokens.css`; Jarvis layer in `hud.css`)

Dark (default):
```
--bg #0C0E13  --bg-raised #12151C  --bg-sunken #08090D  --bg-hover #171B23  --bg-active #1C212B
--border rgba(236,238,243,.07)  --border-strong rgba(236,238,243,.13)   (hairlines in the text colour)
--text #ECEEF3  --text-muted #A4ABBA  --text-faint #7C8597 (4.9:1 on raised)
--accent #4FD1F7 (arc reactor)  --accent-ink #06222C
--warning #E8A33D (needs you)  --success #4CC38A  --danger #E5484D  --info #7AA2FF
--agent-claude #F0905F  --agent-codex #B6A6FF
--highlight inset 0 1px 0 rgba(255,255,255,.06)   (active row, primary button)
--focus 0 0 0 3px rgba(79,209,247,.22)            (inputs; everything else gets a 2px accent outline)
```
Light ("Lab"): `--bg #F6F7F9`, `--bg-raised #FFFFFF`, hairlines `rgba(17,21,30,.08)`, `--text #11151E`, `--text-muted #4A5263`, `--text-faint #677083`, `--accent #0777A3` (5:1 with white), agents `#B24E24` / `#6A52C9`. All text at least 4.5:1.

Accent budget: cyan marks only the current selection and live agent activity (lamp, running labels, reactor core). Primary buttons, switches and checkboxes use `--primary`: the off-white of the text ramp in dark, ink in light. Amber is only for things that need the owner. Agent colours only say which agent.

Type: **Geist** (UI) and **Geist Mono** (IDs, tokens, timestamps, commands, telemetry figures), self-hosted. Scale 11 / 12 / 13 / 14 (base) / 16 / 20 / 24 / 28. Weights 400 and 500; 600 only for rare emphasis. Page titles 24–28 at 500. Section labels 13px, weight 500, muted text, sentence case. Telemetry figures mono 28 at 400, tabular. No negative tracking under 16px.

Space: 4px grid. Radius: 8 (controls), 12 (panels); nested radius = outer − padding. Depth comes from surface steps and hairlines; shadows only on overlays.

Motion: one curve, `cubic-bezier(.22,1,.36,1)`. 140 ms for feedback, 200 ms for entrances. Animate opacity, transform and colour only. The reactor dial turns once per 40 s and only while agents run; the voice ring turns only while hearing or speaking. All of it is off under `prefers-reduced-motion`.

Signature elements: the **reactor core** (an instrument dial; concentric arcs = Claude/Codex 5 h and weekly usage; centre = running agents, lit while they run), the **telemetry strip** on Home, and the **lamp** dot.

Icons: `lucide-react`, 16px, 1.5 stroke, `currentColor`.

## Layout
- Desktop (≥ 1024): 248px sidebar (sections: Home, Board, Approvals, Research, Updates, Projects, People, Memory, Skills, Schedules, Usage, Settings — with counts for Needs-you/Approvals), content max-width 1200, optional right detail pane (run view opens as a pane from the Board).
- Mobile (< 768): bottom tab bar (Home, Board, **+ capture**, Approvals, More), 16px gutters, no horizontal scroll at 375px, tap targets ≥ 44px, sheets instead of side panes.
- **Command palette** (Ctrl/Cmd+K): create task, jump to page/task/note, run schedule, switch theme. Keyboard shortcuts: `c` new task, `g b` board, `g a` approvals, `/` search, `j/k` list navigation, `Esc` close.

## Key components
- **Command bar** (Home top): single large input, placeholder rotates real examples ("Research the best Postgres backup tools", "Fix the login bug in ClientEasy"); shows predicted type, project and agent chips before submit; mic button for dictation; Enter to create, Shift+Enter newline.
- **Ask**: one conversation column with user messages, live thinking and collapsible real tool steps, then the streamed answer. The composer provides attachments and per-message agent/model/effort controls; an agent strip shows status and real plan usage. Quiet answer actions: Ask both, Second opinion and Remember; searchable history sits alongside the thread.
- **Agent badge**: small dot + name in agent colour (`Claude`, `Codex`). Routing reason on hover/tap.
- **Status**: dot + label; the `running` dot is the lit lamp and gently pulses (it is live). Consistent everywhere.
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
