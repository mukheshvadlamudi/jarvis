// Quality gate: screenshots of every page at 375×812 and 1440×900 in dark and light, plus checks for
// console errors and horizontal scroll at phone width. Runs against a seeded mock-mode server.
//   npm run build -w web && node web/scripts/screenshots.mjs [--only=/board,/usage]
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(root, 'docs', 'screenshots');
const port = 4390 + Math.floor(Math.random() * 50);
const base = `http://127.0.0.1:${port}`;
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',');

const dataDir = mkdtempSync(join(tmpdir(), 'jarvis-shots-'));
const server = spawn(process.execPath, [join(root, 'server/src/index.ts')], {
  env: { ...process.env, JARVIS_RUNNER: 'mock', JARVIS_DATA_DIR: dataDir, JARVIS_VAULT: 'fixtures/vault', JARVIS_PORT: String(port), JARVIS_MOCK_DELAY_MS: '2500', JARVIS_SEED: '1', JARVIS_SEED_REPOS: '0', JARVIS_LOG_LEVEL: 'warn' },
  stdio: ['ignore', 'inherit', 'inherit'],
});

async function waitHealthy() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

async function json(path) {
  const r = await fetch(base + path);
  return r.json();
}

const failures = [];
try {
  await waitHealthy();
  await new Promise((r) => setTimeout(r, 4000)); // let the seeded queue start running
  const done = await json('/api/tasks?status=done&limit=50');
  const codeTask = done.tasks.find((t) => t.title.startsWith('Fix the token refresh race')) ?? done.tasks[0];
  const extra = JSON.parse(process.env.SHOT_PAGES ?? '[]');
  let pages = [
    { name: 'ask', path: '/' },
    { name: 'ask-voice', path: '/', click: '.ask-mode button:nth-child(2)', voice: true },
    { name: 'ask-voice-settings', path: '/', voice: true, click: '.ask-mode button:nth-child(2)', settings: true },
    { name: 'ask-conversation', path: '/c/t_demo_auth', action: () => { document.querySelector('.ask-thread').scrollTop = 0; } },
    { name: 'ask-work', path: '/c/t_demo_auth', action: () => { document.querySelector('.ask-thread').scrollTop = 0; }, click: '.work-toggle >> nth=0' },
    { name: 'ask-history', path: '/c/t_demo_auth', click: 'button[aria-label="History"]' },
    { name: 'ask-agents', path: '/c/t_demo_auth', click: 'button[aria-label="Agents"]' },
    { name: 'ask-rich', path: '/c/t_demo_backups', diagram: true, action: () => { document.querySelector('.table-wrap').scrollIntoView({ block: 'start' }); } },
    { name: 'ask-code', path: '/c/t_demo_backups', diagram: true, action: () => { document.querySelector('.code-block').scrollIntoView({ block: 'end' }); } },
    { name: 'ask-options', path: '/', click: 'button[aria-label="Answer options"]' },
    { name: 'home', path: '/overview' },
    { name: 'connectors', path: '/connectors' },
    { name: 'board', path: '/board' },
    { name: 'run', path: `/tasks/${codeTask.id}` },
    { name: 'approvals', path: '/approvals' },
    { name: 'usage', path: '/usage' },
    { name: 'settings', path: '/settings' },
    ...(only?.every((p) => p.startsWith('ask')) ? [] : await import(join(root, 'web/scripts/pages.mjs')).then((m) => m.pages(json, base)).catch(() => [])),
    ...extra,
  ];
  if (only) pages = pages.filter((p) => only.includes(p.path) || only.includes(p.name));
  mkdirSync(outDir, { recursive: true });
  // PLAYWRIGHT_CHANNEL=msedge uses an installed Edge/Chrome instead of the downloaded Chromium.
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {});
  const viewports = [
    { tag: '375', width: 375, height: 812, mobile: true },
    { tag: '1440', width: 1440, height: 900, mobile: false },
  ];
  for (const theme of ['dark', 'light']) {
    for (const vp of viewports) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: theme, deviceScaleFactor: vp.mobile ? 2 : 1, isMobile: vp.mobile, hasTouch: vp.mobile });
      await ctx.addInitScript((t) => { if (window === window.top) localStorage.setItem('jarvis.theme', t); }, theme);
      for (const p of pages) {
        const page = await ctx.newPage();
        await page.addInitScript(() => { localStorage.setItem('jarvis.ask.mode', 'chat'); localStorage.setItem('jarvis.voice.bubble.hidden', 'true'); });
        // The gate never contacts Gemini, including when a developer has a real key in .env.
        await page.route('**/api/voice/live', (route) => route.fulfill({ json: { configured: true, model: 'gemini-3.8-live', fallbackModel: 'gemini-2.5-flash-native-audio-latest' } }));
        await page.route('**/api/voice/live/token', (route) => route.fulfill({ status: 409, json: { error: 'screenshot', message: 'Offline screenshot fixture' } }));
        await page.route(/https:\/\/.*(googleapis|generativelanguage).*/, (route) => route.abort());
        if (p.voice) await page.emulateMedia({ reducedMotion: 'reduce' });
        const errors = [];
        page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(base + p.path, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(p.wait ?? 1400);
        if (p.diagram) await page.frameLocator('iframe[title="Answer diagram"]').locator('svg').waitFor({ timeout: 20_000 });
        if (p.action) await page.evaluate(p.action);
        if (p.click) {
          await page.click(p.click);
          await page.waitForTimeout(500);
        }
        if (p.settings && vp.mobile) await page.getByRole('button', { name: 'Voice settings', exact: true }).click();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        const file = join(outDir, `${p.name}-${vp.tag}-${theme}.png`);
        await page.screenshot({ path: file, fullPage: !p.click }); // fixed sheets render wrongly in stitched full-page captures
        if (errors.length) failures.push(`${p.name} ${vp.tag} ${theme}: console errors: ${errors.join(' | ')}`);
        if (vp.mobile && overflow > 0) failures.push(`${p.name} ${vp.tag} ${theme}: horizontal scroll ${overflow}px`);
        await page.close();
      }
      await ctx.close();
    }
  }
  await browser.close();
} finally {
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  rmSync(dataDir, { recursive: true, force: true });
}

writeFileSync(join(outDir, 'report.json'), JSON.stringify({ failures, at: new Date().toISOString() }, null, 2));
if (failures.length) {
  console.error(`Quality gate failures:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`Screenshots written to ${outDir}; no console errors; no horizontal scroll at 375 px.`);
