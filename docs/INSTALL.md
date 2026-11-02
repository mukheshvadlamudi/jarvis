# Installing Jarvis (for you, or anyone you give it to)

Jarvis is a **local app**: a small Node server on your computer plus a web interface you can install as a desktop/phone app (PWA). There is no cloud service and no shared account — each person runs their own copy with their own Claude and ChatGPT plans.

## What a person needs
| Required | Why |
|---|---|
| **Node.js 24+** | Runs Jarvis. Windows: `winget install OpenJS.NodeJS.LTS` or nodejs.org |
| **Git** | Coding tasks run in git worktrees. Windows: `winget install Git.Git` |
| **Claude Pro/Max** subscription | Claude Code runs on it (the CLI ships inside Jarvis) |
| **ChatGPT Plus/Pro** subscription | Codex runs on it (the CLI ships inside Jarvis) |
| A folder of notes (Obsidian vault) | Long-term memory. Any folder of `.md` files works |

Optional: GitHub CLI (`gh`) for "Open PR", a Telegram bot for phone approvals, Tailscale for phone access.
**Not needed:** API keys, Docker, Python, a database server, global installs of `claude` or `codex`.

## Install
1. Download the project (GitHub → Code → Download ZIP) and unzip it somewhere permanent, e.g. `Documents\Jarvis`.
2. Start it:
   - **Windows:** double-click `start-jarvis.cmd`
   - **macOS:** double-click `start-jarvis.command` (first time: right-click → Open)
   - **Linux:** `./start-jarvis.sh`
3. The first start installs dependencies, builds the interface, creates `.env`, and offers the two one-time logins:
   - **Claude:** Claude Code opens — type `/login`, pick your subscription, finish in the browser, type `/exit`.
   - **Codex:** choose "Sign in with ChatGPT" in the browser.
4. Jarvis opens at http://127.0.0.1:4317 on the **Setup** page: verify both logins (one tiny run each), choose the vault folder, find and connect your code folders, optionally sync skills, turn on routines and connect Telegram. "Restart now" applies saved settings.
5. Install it as an app: Chrome/Edge → install icon in the address bar (or Setup → **Install Jarvis**). It then has its own window, icon and Start-menu entry.

From then on: double-click the launcher (or the installed app once Jarvis is running). To try it without touching any plan: `start-jarvis.cmd --demo` (or `npm run demo`).

## Updating
Download the new version over the old folder (keep `data/` and `.env`), then start it again — the launcher rebuilds when needed. With git: `git pull` then start.

## Where things live
- `data/` — database, settings chosen in Setup (`local-env.json`), backups. Never commit or share it.
- `.env` — ports, remote access, Telegram, runner mode.
- Your vault stays where it is; Jarvis only writes through reviewed proposals (plus the daily log).
- Logins stay in Claude Code's and Codex's own stores (`~/.claude`, `~/.codex`); Jarvis never reads them.

## Why not Electron?
The project rules exclude Electron: it would bundle a second Chromium (~200–300 MB RAM) on an 8 GB laptop. The installed PWA uses the browser you already have and gives the same app window. If a signed one-file installer is ever needed, a Tauri shell (uses the system WebView, ~10 MB) around the same server is the path that keeps the RAM budget.
