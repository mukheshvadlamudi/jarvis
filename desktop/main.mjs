// Jarvis desktop app: an Electron shell around the local Jarvis server.
// The server runs on Electron's own Node 24 (ELECTRON_RUN_AS_NODE), so users don't need Node installed.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, statSync, truncateSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, Notification, shell, Tray } from 'electron';
import { layout, loginTerminalCommand, parseSse, readEnvFile, serverEnv } from './lib.mjs';
import { installAnywhere } from './anywhere.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const paths = layout({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appDir: here, userData: app.getPath('userData') });
if (process.env.JARVIS_DATA_DIR) paths.dataDir = process.env.JARVIS_DATA_DIR;
const fileEnv = readEnvFile(paths.envFile);
const PORT = process.env.JARVIS_PORT || fileEnv.JARVIS_PORT || '4317';
const TOKEN = process.env.JARVIS_ACCESS_TOKEN || fileEnv.JARVIS_ACCESS_TOKEN || '';
const ORIGIN = `http://127.0.0.1:${PORT}`;
const isLocal = (url) => URL.parse(String(url))?.origin === ORIGIN;
const openWebLink = (url) => {
  const parsed = URL.parse(url);
  if (parsed && ['https:', 'http:'].includes(parsed.protocol)) void shell.openExternal(parsed.href).catch(() => {});
};
const RESTART = 75;

let win = null;
let tray = null;
let server = null;
let quitting = false;
let attached = false; // a Jarvis server was already running (e.g. started by start-jarvis)
let toldAboutTray = false;

const icon = () => nativeImage.createFromPath(join(here, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'));
const dark = () => nativeTheme.shouldUseDarkColors;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}
app.setAppUserModelId('com.jarvis.desktop');

async function healthy() {
  try {
    const r = await fetch(`${ORIGIN}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

function startServer() {
  mkdirSync(dirname(paths.logFile), { recursive: true });
  if (existsSync(paths.logFile) && statSync(paths.logFile).size > 5 * 1024 * 1024) truncateSync(paths.logFile, 0);
  const log = createWriteStream(paths.logFile, { flags: 'a' });
  log.write(`\n--- ${new Date().toISOString()} starting Jarvis ${app.getVersion()} ---\n`);
  const env = serverEnv(process.env, {
    ...fileEnv,
    JARVIS_PORT: PORT,
    JARVIS_DATA_DIR: paths.dataDir,
    JARVIS_LAUNCHER: '1',
    JARVIS_DESKTOP: '1',
  });
  server = spawn(process.execPath, [paths.serverEntry], { cwd: paths.root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  server.stdout.pipe(log, { end: false });
  server.stderr.pipe(log, { end: false });
  server.on('exit', async (code) => {
    server = null;
    if (quitting) return;
    if (code === RESTART) {
      startServer();
      await waitForServer();
      win?.loadURL(ORIGIN + '/setup');
      return;
    }
    const r = await dialog.showMessageBox({
      type: 'error',
      title: 'Jarvis stopped',
      message: 'The Jarvis server stopped unexpectedly.',
      detail: `Details are in ${paths.logFile}`,
      buttons: ['Restart', 'Open log', 'Quit'],
      defaultId: 0,
    });
    if (r.response === 0) {
      startServer();
      await waitForServer();
      win?.loadURL(ORIGIN);
    } else if (r.response === 1) {
      await shell.openPath(paths.logFile);
      app.quit();
    } else app.quit();
  });
}

async function waitForServer(timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await healthy()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function stopServer() {
  if (!server) return;
  const child = server;
  try {
    await fetch(`${ORIGIN}/api/shutdown`, { method: 'POST', headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}, signal: AbortSignal.timeout(2000) });
  } catch {
    // fall through to kill
  }
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      child.kill();
      resolve();
    }, 6000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

function createWindow() {
  const isMac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 380,
    minHeight: 560,
    show: false,
    title: 'Jarvis',
    icon: icon(),
    backgroundColor: dark() ? '#05080D' : '#F4F7FA',
    titleBarStyle: 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 14, y: 12 } } : { titleBarOverlay: { color: dark() ? '#0A1119' : '#FFFFFF', symbolColor: dark() ? '#93A7B9' : '#4B5C6C', height: 36 } }),
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      // Voice: Jarvis may speak without a click, like a native assistant.
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  // The local Jarvis page may use the microphone (hands-free voice); nothing else gets permissions.
  win.webContents.session.setPermissionRequestHandler((wc, permission, done, details) => {
    done(wc === win?.webContents && permission === 'media' && isLocal(details.requestingUrl ?? wc.getURL()));
  });
  win.webContents.session.setPermissionCheckHandler((wc, permission, origin) => wc === win?.webContents && permission === 'media' && isLocal(origin));
  win.loadFile(join(here, 'splash.html'));
  win.once('ready-to-show', () => win.show());

  // Links to other sites open in the default browser; the app never navigates away from Jarvis.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isLocal(url)) openWebLink(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isLocal(url)) {
      e.preventDefault();
      openWebLink(url);
    }
  });
  win.webContents.on('will-redirect', (e, url) => { if (!isLocal(url)) e.preventDefault(); });
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!toldAboutTray && Notification.isSupported()) {
      toldAboutTray = true;
      new Notification({ title: 'Jarvis is still running', body: 'Routines and runs continue in the background. Use the tray icon to open or quit.', icon: icon() }).show();
    }
  });
  nativeTheme.on('updated', () => {
    if (process.platform !== 'darwin') win?.setTitleBarOverlay?.({ color: dark() ? '#0A1119' : '#FFFFFF', symbolColor: dark() ? '#93A7B9' : '#4B5C6C' });
  });
}

function showWindow(path) {
  if (!win) createWindow();
  if (path) void win.loadURL(ORIGIN + path);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function capture() {
  showWindow();
  win.webContents.send('jarvis:capture');
}

function buildTray() {
  const img = icon().resize({ width: 18, height: 18 });
  tray = new Tray(img);
  tray.setToolTip('Jarvis');
  const menu = () =>
    Menu.buildFromTemplate([
      { label: 'Open Jarvis', click: () => showWindow() },
      { label: 'New task…', accelerator: 'CommandOrControl+Shift+J', click: capture },
      { label: 'Approvals', click: () => showWindow('/approvals') },
      { type: 'separator' },
      { label: 'Start at login', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked, openAsHidden: true }) },
      { label: 'Open data folder', click: () => void shell.openPath(paths.dataDir) },
      { type: 'separator' },
      { label: 'Quit Jarvis', click: () => app.quit() },
    ]);
  tray.setContextMenu(menu());
  tray.on('click', () => showWindow());
  tray.on('right-click', () => tray.setContextMenu(menu()));
}

/** Native notifications from the live event stream (approvals, finished tasks, agent messages). */
async function watchEvents() {
  const titles = new Map();
  for (;;) {
    if (quitting) return;
    try {
      const res = await fetch(`${ORIGIN}/api/stream`, { headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {} });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const { events, rest } = parseSse(buf + decoder.decode(value, { stream: true }));
        buf = rest;
        for (const e of events) notify(e, titles);
      }
    } catch {
      // server restarting: retry
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

function notify(e, titles) {
  if (!Notification.isSupported()) return;
  const focused = win?.isFocused();
  const show = (title, body, path, urgent = false) => {
    const n = new Notification({ title, body, icon: icon(), urgency: urgent ? 'critical' : 'normal', silent: !urgent });
    n.on('click', () => showWindow(path));
    n.show();
  };
  if (e.type === 'task.updated' && e.data?.id) titles.set(e.data.id, e.data);
  if (e.type === 'approval.created') {
    show('Approval needed', e.data?.summary ?? 'An agent is waiting for you', '/approvals', true);
    if (process.platform === 'darwin') app.dock?.bounce('informational');
    else win?.flashFrame(true);
  } else if (e.type === 'run.finished' && !focused) {
    const t = titles.get(e.data?.task_id);
    if (e.data?.status === 'done' && t) show(`Done: ${t.title}`, (t.result_summary ?? '').slice(0, 180), `/tasks/${t.id}`);
    if (e.data?.status === 'failed' && t) show(`Failed: ${t.title}`, (e.data.error ?? '').slice(0, 180), `/tasks/${t.id}`);
  } else if (e.type === 'notify') {
    show(e.data?.level === 'warning' ? 'Jarvis — attention' : 'Jarvis', e.data?.message ?? '', '/');
  }
}

/** Open a terminal running the bundled Claude Code / Codex login (plan accounts, never API keys). */
function openLogin(agent) {
  const require = createRequire(join(paths.root, 'package.json'));
  let target;
  if (agent === 'claude') {
    for (const pkg of [`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`, `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}-musl`]) {
      try {
        const dir = dirname(require.resolve(`${pkg}/package.json`));
        const exe = join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
        if (existsSync(exe)) target = { exe, args: [] };
      } catch {
        // not this variant
      }
    }
  } else {
    try {
      target = { exe: process.execPath, args: [join(dirname(require.resolve('@openai/codex/package.json')), 'bin', 'codex.js'), 'login'], env: { ELECTRON_RUN_AS_NODE: '1' } };
    } catch {
      target = undefined;
    }
  }
  if (!target) return { ok: false, message: `The ${agent} CLI is missing from this install.` };
  const { cmd, args } = loginTerminalCommand(process.platform, target);
  const env = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY']) delete env[k];
  spawn(cmd, args, { detached: true, stdio: 'ignore', env, shell: false }).unref();
  return { ok: true, message: agent === 'claude' ? 'A terminal opened: type /login, choose your Claude subscription, finish in the browser, then /exit.' : 'A terminal opened: choose “Sign in with ChatGPT” in the browser.' };
}

function localIpc(handler) {
  return (e, ...args) => {
    if (e.sender !== win?.webContents || !e.senderFrame || e.senderFrame.parent || !isLocal(e.senderFrame.url)) {
      throw new Error('Jarvis desktop commands are only available from the main window');
    }
    return handler(...args);
  };
}
ipcMain.handle('jarvis:login', localIpc((agent) => (agent === 'claude' || agent === 'codex' ? openLogin(agent) : { ok: false, message: 'unknown agent' })));
ipcMain.handle('jarvis:open-path', localIpc((which) => shell.openPath(which === 'logs' ? dirname(paths.logFile) : paths.dataDir)));
ipcMain.handle('jarvis:info', localIpc(() => ({ version: app.getVersion(), packaged: app.isPackaged, dataDir: paths.dataDir, attached })));

app.whenReady().then(async () => {
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]) : null);
  createWindow();
  buildTray();
  globalShortcut.register('CommandOrControl+Shift+J', capture);
  attached = await healthy();
  if (!attached) startServer();
  const ok = await waitForServer();
  if (!ok) {
    await dialog.showMessageBox({ type: 'error', title: 'Jarvis', message: 'Jarvis could not start.', detail: `See ${paths.logFile}` });
    app.quit();
    return;
  }
  await installAnywhere({ here, userData: app.getPath('userData'), origin: ORIGIN, token: TOKEN, packaged: app.isPackaged, showWindow,
    onActiveChange: (active) => win?.webContents.send('jarvis:anywhere-active', active) });
  await win.loadURL(ORIGIN);
  void watchEvents();
});

app.on('activate', () => showWindow());
app.on('window-all-closed', () => {
  // keep running in the tray
});
app.on('before-quit', async (e) => {
  if (quitting) return;
  quitting = true;
  globalShortcut.unregisterAll();
  if (server && !attached) {
    e.preventDefault();
    await stopServer();
    app.quit();
  }
});
