# Installing Jarvis (for you, or anyone you give it to)

Jarvis is a **local app**: a small server on your computer plus its interface. There is no cloud service and no shared account — each person runs their own copy with their own Claude and ChatGPT plans. Two ways to run it:

## Option A — Desktop app (recommended)
1. Download the installer for your system from the project's **Releases** page (or from a manually started **Actions → Desktop app → Run workflow** run, under *Artifacts*, kept for 3 days):
   - Windows: `Jarvis-Setup-x.y.z.exe` (or `Jarvis-Portable-x.y.z.exe`, no install)
   - macOS: `Jarvis-x.y.z-arm64.dmg` (unsigned: first open with right-click → Open)
   - Linux: `Jarvis-x.y.z-x86_64.AppImage` or `.deb`
2. Install and open **Jarvis**. Nothing else is needed — Node and both agent CLIs are inside the app. Git is still needed for coding tasks.
3. The **Setup** page opens: press **Log in to Claude** and **Log in to Codex** (a terminal window opens for each one-time login), verify both, choose your vault, find your code folders.
4. Closing the window keeps Jarvis in the tray so routines keep running. `Ctrl+Shift+J` captures a task from anywhere. Tray → *Start at login* to have it always on.

Desktop data lives in `%APPDATA%\Jarvis\data` (Windows), `~/Library/Application Support/Jarvis/data` (macOS) or `~/.config/Jarvis/data` (Linux).

### Jarvis anywhere (desktop only)

In **Settings → Voice → Jarvis anywhere**, enable the overlay, choose a shortcut and select **Ask Jarvis** or **Dictate**. The default is **Ctrl+Space**. If another app owns it, Jarvis tries **Ctrl+Alt+Space** and shows a warning with the active shortcut. If both are unavailable, choose another accelerator, such as `Control+Shift+Space`. These preferences are saved in `anywhere.json` in the desktop user-data folder.

Tap the shortcut from another app to talk. The small overlay appears near the bottom centre of the display; **Tab** switches modes and remembers your choice, and **Esc** closes it and returns focus. You can also hold the shortcut: releasing it after opening the overlay finishes the turn once the voice engine has transcribed the last words. A short tap keeps listening; tap again or press **Finish** to finish. Speech ends a turn automatically after a pause. Allow the microphone when prompted; system microphone restrictions still apply. The existing local Whisper/VAD voice engine is reused; the first use downloads models.

**Ask Jarvis** starts a conversation and continues that overlay conversation on subsequent turns. It shows a compact answer and **Open in Jarvis** opens the full thread, including any approvals. Focus returns to the previous app when the answer finishes. **Dictate** transcribes locally, saves the existing clipboard formats, copies the transcript, restores the previous app and pastes. About one second later it restores the clipboard, unless you have copied something newer. If focusing or pasting fails, the transcript stays visible for manual copying.

Windows uses PowerShell and Windows Forms `SendKeys` for paste. macOS uses System Events and may require Accessibility/Automation permission for Jarvis. Linux requires `xdotool` and an X11 session; Wayland compositors can prevent focus and paste automation. The browser/PWA has no global shortcut or paste automation. Native focus, shortcut release delivery and microphone permissions should be checked on each target OS.

Integration needed from the shared voice owner: subscribe to the desktop preload's `onAnywhereActive(active)` event and suspend the main window's hands-free microphone while `active` is true, then restore its previous state. Until that is connected, leave the main window's hands-free Voice off while using the overlay to avoid duplicate recognition. No shared `/overlay` route is needed: Electron serves the bundled `desktop/overlay.html` entry on the local server origin in an isolated session.

### Let Claude use your Chrome (optional)

1. Follow the official [Claude in Chrome installation guide](https://code.claude.com/docs/en/chrome), install the extension, and connect it to Claude Code. Use a **claude.ai plan login** through `/login`; API keys and setup tokens do not enable Chrome.
2. Turn on **Settings → Agents → Claude can use your Chrome** and save. This sets `agents.claude.chrome` in `data/config.json` (default `false`). Each new Claude run receives the SDK option `extraArgs: { chrome: null }`, equivalent to `--chrome`.
3. In **Setup → Install Claude in Chrome**, run the optional tiny verification after enabling the switch. It checks whether a run with the flag completes cleanly, records its result locally and never runs automatically. Mock mode does not call Claude. Successful startup does **not** prove extension connectivity: check `/chrome` in Claude Code for the installed/connected extension.

You approve sites in the extension. Jarvis additionally asks before Claude in Chrome mutation tools, including `computer`, `form_input`, `javascript_tool` and `browser_batch`, because clicks, typing and scripts can submit forms, send messages or make purchases. This runner-level check applies even if Chrome was enabled in Claude Code itself and forces risky calls through Jarvis approval hooks. Read-only page/context tools remain available. The extension's per-site permission is a separate control; review it before granting sensitive sites. No real Chrome run is made by automated tests.

## Option B — From the source folder (launcher or browser app)

## What a person needs
| Required | Why |
|---|---|
| **Node.js 24+** | Runs Jarvis. Windows: `winget install OpenJS.NodeJS.LTS` or nodejs.org |
| **Git** | Coding tasks run in git worktrees. Windows: `winget install Git.Git` |
| **Claude Pro/Max** subscription | Claude Code runs on it (the CLI ships inside Jarvis) |
| **ChatGPT Plus/Pro** subscription | Codex runs on it (the CLI ships inside Jarvis) |
| A folder of notes (Obsidian vault) | Long-term memory. Any folder of `.md` files works |

Optional: a microphone for hands-free voice. The voice models download once (~170 MB) and then run offline. Allow about 1 GB of RAM while voice is on, or use Settings → Voice → Light. Optional: GitHub CLI (`gh`) for "Open PR", a Telegram bot for phone approvals, Tailscale for phone access.
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
