import { app, BrowserWindow, clipboard, ClipboardItem, dialog, globalShortcut, ipcMain, screen, session } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pasteWithClipboard, registerAnywhereShortcut } from './lib.mjs';
import { captureFocus, restoreFocus, paste } from './focus.mjs';

export async function installAnywhere({ here, userData, origin, token, packaged, showWindow, onActiveChange = () => {} }) {
  if (!packaged) await (await import('./build-overlay.mjs')).buildOverlay();
  const settingsFile = join(userData, 'anywhere.json');
  let prefs = { enabled: true, shortcut: 'Control+Space', mode: 'ask' };
  try { prefs = validate({ ...prefs, ...JSON.parse(readFileSync(settingsFile, 'utf8')) }); } catch { /* defaults */ }
  let registered = null;
  let warning = '';
  let overlay = null;
  let target = null;
  let opening = false;
  let pasting = false;
  let shownAt = 0;
  let micAllowed = false;
  let quitting = false;
  app.on('before-quit', () => { quitting = true; });
  function place(height) {
    const bounds = target?.bounds;
    const validBounds = bounds && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(bounds[key])) && bounds.width > 0 && bounds.height > 0;
    const displayBounds = validBounds && process.platform === 'win32' ? screen.screenToDipRect(null, bounds) : bounds;
    const area = (validBounds ? screen.getDisplayMatching(displayBounds) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())).workArea;
    const width = Math.min(560, area.width - 24);
    overlay.setBounds({ x: Math.round(area.x + (area.width - width) / 2), y: area.y + area.height - height - 24, width, height });
  }
  const isolated = session.fromPartition('persist:jarvis-anywhere');
  isolated.setPermissionRequestHandler(async (wc, permission, done, details) => {
    if (wc !== overlay?.webContents || permission !== 'media' || details.mediaTypes?.includes('video') || new URL(details.requestingUrl || wc.getURL()).origin !== origin) return done(false);
    if (!micAllowed) {
      const result = await dialog.showMessageBox(overlay, { type: 'question', title: 'Jarvis anywhere microphone', message: 'Allow Jarvis anywhere to use your microphone?', detail: 'Speech recognition runs on this device. You can disable Jarvis anywhere in Settings → Voice.', buttons: ['Allow microphone', 'Cancel'], defaultId: 0, cancelId: 1 });
      micAllowed = result.response === 0;
    }
    done(micAllowed);
  });
  isolated.setPermissionCheckHandler((wc, permission, requestingOrigin) => micAllowed && wc === overlay?.webContents && permission === 'media' && requestingOrigin === origin);
  // Serve the desktop entry on the server's origin so the shared voice workers and /voice-runtime
  // use the existing build. The server needs no route and this session has no Node access.
  isolated.protocol.handle('http', async (request) => {
    const url = new URL(request.url);
    if (url.origin !== origin) return new Response('Not allowed', { status: 403 });
    if (url.pathname.startsWith('/__desktop/')) {
      const root = resolve(here, 'overlay-build');
      const file = resolve(root, decodeURIComponent(url.pathname.slice('/__desktop/'.length)));
      if (!file.startsWith(root + sep)) return new Response('', { status: 403 });
      try {
        const mime = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.woff2') ? 'font/woff2' : 'text/javascript';
        return new Response(readFileSync(file), { headers: { 'content-type': mime, 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' } });
      } catch { return new Response('Missing desktop asset', { status: 404 }); }
    }
    const headers = new Headers(request.headers);
    if (token) headers.set('authorization', `Bearer ${token}`);
    return fetch(request.url, { method: request.method, headers, ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: await request.arrayBuffer() }), signal: AbortSignal.timeout(30_000) });
  });

  async function close() {
    if (!overlay?.isVisible()) return;
    overlay.webContents.send('jarvis:anywhere', { action: 'close' });
    onActiveChange(false);
    overlay.hide();
    try { if (target) await restoreFocus(target); } catch { /* never paste if focus fails */ }
  }
  async function toggle() {
    if (opening || pasting) return;
    if (overlay?.isVisible()) {
      if (!overlay.isFocused()) {
        try { target = await captureFocus(); } catch { target = null; }
        overlay.focus();
      }
      onActiveChange(true);
      overlay.webContents.send('jarvis:anywhere', { action: 'toggle' }); return;
    }
    opening = true;
    try {
      try { target = await captureFocus(); } catch { target = null; }
      if (!overlay) {
        overlay = new BrowserWindow({ width: 560, height: 180, frame: false, transparent: true, alwaysOnTop: true, resizable: false, show: false, skipTaskbar: true,
          webPreferences: { preload: join(here, 'preload.cjs'), session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: 'no-user-gesture-required' } });
        overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        overlay.webContents.on('will-navigate', (event) => event.preventDefault());
        overlay.webContents.on('before-input-event', (event, input) => {
          if (input.key === 'Escape') { event.preventDefault(); void close(); }
          // The overlay receives key-up after the global key-down opened it. Short taps stay open.
          const key = (registered || prefs.shortcut).split('+').at(-1).toLowerCase();
          const released = key === 'space' ? input.key === ' ' || input.code === 'Space' : input.key.toLowerCase() === key;
          if (input.type === 'keyUp' && released && Date.now() - shownAt > 350) {
            overlay.webContents.send('jarvis:anywhere', { action: 'finish' });
          }
        });
        overlay.on('close', (event) => { if (!quitting) { event.preventDefault(); void close(); } });
        await overlay.loadURL(origin + '/__desktop/overlay.html');
      }
      place(180);
      shownAt = Date.now();
      overlay.show();
      overlay.focus();
      overlay.webContents.send('jarvis:anywhere', { action: 'start', mode: prefs.mode });
      onActiveChange(true);
    } finally { opening = false; }
  }
  function register() {
    if (registered) globalShortcut.unregister(registered);
    registered = null;
    warning = '';
    if (prefs.enabled) {
      const result = registerAnywhereShortcut(globalShortcut.register.bind(globalShortcut), prefs.shortcut, () => void toggle().catch((e) => dialog.showErrorBox('Jarvis anywhere', e.message)));
      registered = result.shortcut;
      warning = result.warning;
      if (warning) void dialog.showMessageBox({ type: 'warning', title: 'Jarvis anywhere shortcut', message: warning });
    } else void close();
  }
  const trusted = (event) => {
    try { return new URL(event.senderFrame.url).origin === origin; } catch { return false; }
  };
  ipcMain.handle('jarvis:anywhere-settings', (event, patch) => {
    if (!trusted(event)) throw new Error('Untrusted page');
    if (patch !== undefined) {
      const next = validate({ ...prefs, ...patch });
      const needsRegister = next.enabled !== prefs.enabled || next.shortcut !== prefs.shortcut;
      writeFileSync(settingsFile, JSON.stringify(next));
      prefs = next;
      if (needsRegister) register();
    }
    return { ...prefs, registered, warning };
  });
  ipcMain.handle('jarvis:anywhere-close', (event) => { if (event.sender === overlay?.webContents) return close(); });
  ipcMain.handle('jarvis:anywhere-expand', (event) => { if (event.sender === overlay?.webContents) { place(300); onActiveChange(false); } });
  ipcMain.handle('jarvis:anywhere-release-focus', async (event) => {
    if (event.sender === overlay?.webContents) onActiveChange(false);
    if (event.sender === overlay?.webContents && target) { try { await restoreFocus(target); } catch { /* overlay can still be closed with Esc */ } }
  });
  ipcMain.handle('jarvis:anywhere-open', (event, id) => {
    if (event.sender !== overlay?.webContents || !/^[\w-]+$/.test(id ?? '')) return;
    overlay.webContents.send('jarvis:anywhere', { action: 'close' });
    onActiveChange(false);
    overlay.hide();
    showWindow(`/c/${encodeURIComponent(id)}`);
  });
  ipcMain.handle('jarvis:anywhere-paste', async (event, text) => {
    if (event.sender !== overlay?.webContents || pasting || typeof text !== 'string' || !text.trim() || text.length > 100000) throw new Error('Invalid dictation');
    pasting = true;
    try {
      await pasteWithClipboard(text, {
        // Electron 45 exposes async ClipboardItems. Materialize all formats before replacing them,
        // then restore the items atomically (separate writes would lose rich/custom formats).
        save: async () => Promise.all((await clipboard.read()).map(async (item) => new ClipboardItem(Object.fromEntries(
          await Promise.all(item.types.map(async (type) => [type, await item.getType(type)])),
        )))),
        write: (value) => clipboard.writeText(value),
        restoreFocus: async () => { overlay.hide(); await restoreFocus(target); },
        paste,
        delay: (ms) => new Promise((r) => setTimeout(r, ms)),
        unchanged: async (value) => await clipboard.readText() === value,
        restore: (items) => items.length ? clipboard.write(items) : clipboard.clear(),
      });
      return { ok: true };
    } catch (error) {
      overlay.show(); overlay.focus();
      return { ok: false, message: error.message };
    } finally { pasting = false; }
  });
  register();
}

function validate(value) {
  if (typeof value.enabled !== 'boolean' || typeof value.shortcut !== 'string' || value.shortcut.length > 80 || !value.shortcut.trim() || !['ask', 'dictate'].includes(value.mode)) throw new Error('Choose a valid shortcut and mode');
  return { enabled: value.enabled, shortcut: value.shortcut.trim(), mode: value.mode };
}
