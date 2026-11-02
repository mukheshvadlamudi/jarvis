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
  env: { ...process.env, JARVIS_RUNNER: 'mock', JARVIS_DATA_DIR: dataDir, JARVIS_PORT: String(port), JARVIS_MOCK_DELAY_MS: '2500', JARVIS_SEED: '1', JARVIS_LOG_LEVEL: 'warn' },
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
    { name: 'home', path: '/' },
    { name: 'board', path: '/board' },
    { name: 'run', path: `/tasks/${codeTask.id}` },
    { name: 'approvals', path: '/approvals' },
    { name: 'usage', path: '/usage' },
    { name: 'settings', path: '/settings' },
    ...(await import(join(root, 'web/scripts/pages.mjs')).then((m) => m.pages(json)).catch(() => [])),
    ...extra,
  ];
  if (only) pages = pages.filter((p) => only.includes(p.path) || only.includes(p.name));
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const viewports = [
    { tag: '375', width: 375, height: 812, mobile: true },
    { tag: '1440', width: 1440, height: 900, mobile: false },
  ];
  for (const theme of ['dark', 'light']) {
    for (const vp of viewports) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: theme, deviceScaleFactor: vp.mobile ? 2 : 1, isMobile: vp.mobile, hasTouch: vp.mobile });
      await ctx.addInitScript((t) => localStorage.setItem('jarvis.theme', t), theme);
      for (const p of pages) {
        const page = await ctx.newPage();
        const errors = [];
        page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(base + p.path, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(p.wait ?? 1400);
        if (p.action) await page.evaluate(p.action).catch(() => undefined);
        if (p.click) {
          await page.click(p.click).catch(() => undefined);
          await page.waitForTimeout(500);
        }
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        const file = join(outDir, `${p.name}-${vp.tag}-${theme}.png`);
        await page.screenshot({ path: file, fullPage: true });
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
