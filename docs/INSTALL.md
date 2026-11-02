# Installing Jarvis (for you, or anyone you give it to)

Jarvis is a **local app**: a small server on your computer plus its interface. There is no cloud service and no shared account — each person runs their own copy with their own Claude and ChatGPT plans. Two ways to run it:

## Option A — Desktop app (recommended)
1. Download the installer for your system from the project's **Releases** page (or from the latest **Actions → Desktop app** run, under *Artifacts*):
   - Windows: `Jarvis-Setup-x.y.z.exe` (or `Jarvis-Portable-x.y.z.exe`, no install)
   - macOS: `Jarvis-x.y.z-arm64.dmg` (unsigned: first open with right-click → Open)
   - Linux: `Jarvis-x.y.z-x86_64.AppImage` or `.deb`
2. Install and open **Jarvis**. Nothing else is needed — Node and both agent CLIs are inside the app. Git is still needed for coding tasks.
3. The **Setup** page opens: press **Log in to Claude** and **Log in to Codex** (a terminal window opens for each one-time login), verify both, choose your vault, find your code folders.
4. Closing the window keeps Jarvis in the tray so routines keep running. `Ctrl+Shift+J` captures a task from anywhere. Tray → *Start at login* to have it always on.

Desktop data lives in `%APPDATA%\Jarvis\data` (Windows), `~/Library/Application Support/Jarvis/data` (macOS) or `~/.config/Jarvis/data` (Linux).

## Option B — From the source folder (launcher or browser app)

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

## Desktop app vs. browser app
The desktop app (Electron) is the easiest to install and adds a tray, notifications and a global shortcut; it uses roughly 150–250 MB more RAM than running Jarvis in a browser tab or as an installed PWA. On a tight 8 GB machine, Option B with the PWA is the lightest.

## Building the installers yourself
`npm run package:win` (on Windows), `npm run package:mac` (on a Mac) or `npm run package:linux`. Output goes to `dist-desktop/`. Pushing a tag like `v0.2.0` makes GitHub Actions build all three and publish them as a Release.
