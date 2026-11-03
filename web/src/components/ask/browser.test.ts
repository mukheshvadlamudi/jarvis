import { resolve } from 'node:path';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';

let browser: Browser;
let bundle = '';
let server: Server;
let base = '';
const html = '<style>:root{--text:#eeeeee;--text-muted:#aaaaaa;--bg-raised:#12151c}</style><div id="root"></div><script type="module" src="/bundle.js"></script>';
const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' };
const assets = new Map<string, string | Uint8Array>();
beforeAll(async () => {
  const root = resolve(import.meta.dirname, '../..');
  const entry = `import {createElement} from 'react'; import {createRoot} from 'react-dom/client'; import Ask from '${root.replaceAll('\\', '/')}/pages/Ask.tsx'; import Workflows from '${root.replaceAll('\\', '/')}/pages/Workflows.tsx'; import {connectLive} from '${root.replaceAll('\\', '/')}/lib/live.ts'; connectLive(); createRoot(document.getElementById('root')).render(createElement(location.pathname==='/workflows'?Workflows:Ask,{params:location.pathname.startsWith('/c/')?{id:'test'}:{}}));`;
  const result = await build({ configFile: false, root: resolve(root, '..'), logLevel: 'silent', plugins: [react(), { name: 'ask-test-entry', resolveId: (id) => id === 'virtual:ask-test' ? id : undefined, load: (id) => id === 'virtual:ask-test' ? entry : undefined }], build: { write: false, minify: false, rolldownOptions: { input: 'virtual:ask-test', external: ['@ricky0123/vad-web'], output: { codeSplitting: false } } } });
  const output = Array.isArray(result) ? result[0].output : 'output' in result ? result.output : [];
  bundle = output.map((c) => c.type === 'chunk' ? c.code : '').join('\n');
  for (const c of output) if (c.type === 'asset') assets.set(`/${c.fileName}`, c.source);
  // Opaque sandbox frame requests must have a real origin, even when page routes are mocked.
  server = createServer((req, res) => {
    const asset = assets.get(req.url ?? '');
    const script = req.url === '/bundle.js';
    res.setHeader('Content-Type', asset || script ? 'text/javascript' : 'text/html');
    for (const [key, value] of Object.entries(isolation)) res.setHeader(key, value);
    res.end(asset ?? (script ? bundle : html));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge' } : {});
}, 30_000);
afterAll(async () => { await browser?.close(); if (server) await new Promise<void>((done) => server.close(() => done())); });

async function open(path = '/') {
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  await page.addInitScript(() => {
    // Deterministic SSE transport; no server or real agent process is started.
    const sources: Array<{ handlers: Record<string, (e: { data: string }) => void> }> = [];
    Object.assign(window, { askSources: sources, EventSource: class {
      handlers: Record<string, (e: { data: string }) => void> = {};
      constructor() { sources.push(this); }
      addEventListener(type: string, fn: (e: { data: string }) => void) { this.handlers[type] = fn; }
      close() {}
    } });
  });
  await page.context().route(`${base}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
    const asset = assets.get(url.pathname);
    if (asset) return route.fulfill({ contentType: 'text/javascript', body: typeof asset === 'string' ? asset : Buffer.from(asset) });
    if (!url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'text/html', headers: isolation, body: html });
    const data = url.pathname === '/api/workflows' ? { workflows: [], runs: [], errors: [] } : url.pathname === '/api/agents' ? { agents: {}, threshold: 85 } : url.pathname.startsWith('/api/conversations/') ? { conversation: { id: 'test', title: 'Review launch' }, runs: [], active: false, approvals: [] } : url.pathname === '/api/runs' ? { active: [], runs: [] } : { conversations: [] };
    return route.fulfill({ json: data });
  });
  await page.goto(`${base}${path}`);
  if (path === '/workflows') await page.getByRole('button', { name: 'New workflow' }).waitFor();
  else await page.locator('#ask-input').waitFor();
  return page;
}
const emit = (page: Page, type: string, data: unknown) => page.evaluate(({ type, data }) => { (window as unknown as { askSources: Array<{ handlers: Record<string, (e: { data: string }) => void> }> }).askSources.at(-1)?.handlers[type]?.({ data: JSON.stringify(data) }); }, { type, data });

describe('Ask browser interactions', () => {
  it('shows slash hints and starts the matching workflow in the current conversation', async () => {
    const page = await open('/c/test');
    const workflow = { id: 'research-and-verify', name: 'Research and verify', description: 'Research and independent review', builtIn: true, triggers: ['/research'], input: { label: 'Topic', required: true }, steps: [] };
    try {
      let request: unknown;
      await page.route('**/api/workflows*', r => r.fulfill({ json: { workflows: [workflow], runs: [], errors: [] } }));
      await page.route('**/api/workflows/research-and-verify/run', r => { request = r.request().postDataJSON(); return r.fulfill({ json: { workflowRunId: 'wf', conversationId: 'test' } }); });
      await page.reload();
      await page.locator('#ask-input').fill('/rese');
      await page.getByRole('button', { name: '/research · Research and verify' }).waitFor();
      await page.locator('#ask-input').fill('/research Postgres backups');
      await page.locator('#ask-input').press('Enter');
      await page.waitForFunction(() => (document.querySelector('#ask-input') as HTMLTextAreaElement).value === '');
      expect(request).toEqual({ input: 'Postgres backups', conversationId: 'test' });
      await page.getByRole('button', { name: 'Workflows', exact: true }).click();
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      await page.getByLabel('Topic').fill('Retention');
      await page.getByRole('button', { name: 'Start workflow' }).click();
      expect(request).toEqual({ input: 'Retention', conversationId: 'test' });
    } finally { await page.close(); }
  }, 20_000);
  it('edits a user workflow with ordered steps and saves without a JSON editor', async () => {
    const page = await open('/workflows');
    try {
      let saved: any;
      await page.route('**/api/workflows', r => { if (r.request().method() === 'POST') { saved = r.request().postDataJSON(); return r.fulfill({ json: { workflow: saved } }); } return r.fallback(); });
      await page.getByRole('button', { name: 'New workflow', exact: true }).click();
      await page.getByLabel('Name', { exact: true }).fill('Weekly review');
      await page.getByLabel('Description', { exact: true }).fill('Review notes and summarize priorities');
      await page.getByRole('button', { name: 'Add step', exact: true }).click();
      await page.getByRole('button', { name: 'Move step 2 up' }).click();
      const kinds = page.getByLabel('Kind', { exact: true });
      await kinds.nth(1).selectOption('summary');
      await page.getByRole('button', { name: 'Save workflow', exact: true }).click();
      await page.getByRole('button', { name: 'New workflow', exact: true }).waitFor();
      expect(saved.name).toBe('Weekly review'); expect(saved.steps[0].id).toBe('step-2'); expect(saved.steps[1].kind).toBe('summary');
    } finally { await page.close(); }
  }, 20_000);
  it('blocks failed attachments, requires explicit removal and keeps the draft on server error', async () => {
    const page = await open();
    try {
      let posts = 0;
      await page.route('**/api/uploads', (route) => route.fulfill({ status: 500, json: { message: 'Upload disk is full' } }));
      await page.route('**/api/conversations', (route) => { if (route.request().method() === 'POST') { posts++; return route.fulfill({ status: 500, json: { message: 'Cannot save this message' } }); } return route.fallback(); });
      await page.locator('#ask-input').fill('Review the attached file');
      await page.locator('input[type=file]').setInputFiles({ name: 'launch.txt', mimeType: 'text/plain', buffer: Buffer.from('launch notes') });
      await page.getByRole('alert').waitFor();
      expect(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled()).toBe(true);
      await page.locator('#ask-input').press('Enter'); expect(posts).toBe(0);
      await page.getByRole('button', { name: 'Send without it' }).click();
      await page.waitForFunction(() => !(document.querySelector('button[aria-label=Send]') as HTMLButtonElement).disabled);
      expect(posts).toBe(1); expect(await page.locator('#ask-input').inputValue()).toBe('Review the attached file');
    } finally { await page.close(); }
  });
  it('opens searchable history with the keyboard, traps focus and restores it on Escape', async () => {
    const page = await open();
    try {
      await page.locator('#ask-input').focus();
      await page.keyboard.press('Control+k');
      const dialog = page.getByRole('dialog', { name: 'History', exact: true }); await dialog.waitFor();
      expect(await page.getByPlaceholder('Search', { exact: true }).evaluate((e) => e === document.activeElement)).toBe(true);
      for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
      expect(await dialog.evaluate((e) => e.contains(document.activeElement))).toBe(true);
      await page.keyboard.press('Escape'); expect(await dialog.count()).toBe(0);
      expect(await page.locator('#ask-input').evaluate((e) => e === document.activeElement)).toBe(true);
      await page.getByRole('button', { name: 'Answer options' }).click();
      await page.getByRole('button', { name: 'Codex', exact: true }).click();
      await page.getByLabel('Effort', { exact: true }).selectOption('high');
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      expect(await page.getByRole('button', { name: 'Answer options' }).innerText()).toContain('Codex');
    } finally { await page.close(); }
  });
  it('reloads conversation and active runs after an epoch change, and rejects late completed deltas', async () => {
    const page = await open('/c/test');
    try {
      let reads = 0; let activeReads = 0;
      const run = { id: 'run', task_id: 'test', agent: 'claude', purpose: 'user_reply', visibility: 'conversation', owner_text: 'Review launch', status: 'done', answer: 'Recovered answer', started_at: new Date().toISOString(), ended_at: new Date().toISOString(), events: [] };
      await page.route('**/api/conversations/test', (route) => { reads++; return route.fulfill({ json: { conversation: { id: 'test', title: 'Review launch' }, runs: [run], approvals: [], active: false } }); });
      await page.route('**/api/runs', (route) => { activeReads++; return route.fulfill({ json: { active: [] } }); });
      await emit(page, 'hello', { epoch: 'before' }); await emit(page, 'hello', { epoch: 'after' });
      await page.getByText('Recovered answer', { exact: true }).waitFor();
      expect(reads).toBeGreaterThan(0); expect(activeReads).toBeGreaterThan(0);
      await emit(page, 'run.delta', { taskId: 'test', runId: 'run', text: 'STALE DELTA' });
      expect(await page.getByText('STALE DELTA').count()).toBe(0);
    } finally { await page.close(); }
  });
  it('renders Mermaid locally in a sandbox, follows the theme and exposes invalid diagram source', async () => {
    const page = await open('/c/test');
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (e) => { if (e.type() === 'error') errors.push(e.text()); });
    try {
      let answer = '```mermaid\nflowchart LR\n A[Review] --> B[Launch]\n```';
      await page.route('**/api/conversations/test', (route) => route.fulfill({ json: { conversation: { id: 'test', title: 'Review launch' }, runs: [{ id: 'r', agent: 'claude', purpose: 'user_reply', owner_text: 'Show the launch flow', visibility: 'conversation', status: 'done', answer, events: [], started_at: new Date().toISOString(), ended_at: new Date().toISOString() }], approvals: [], active: false } }));
      await page.reload();
      await page.addStyleTag({ content: ':root {--text:#eeeeee;--text-muted:#aaaaaa;--bg-raised:#12151c} :root[data-theme=light] {--text:#111111;--text-muted:#555555;--bg-raised:#ffffff}' });
      const frame = page.frameLocator('iframe[title="Answer diagram"]');
      await frame.locator('svg').waitFor({ timeout: 10_000 }).catch(async (err: Error) => { throw new Error(`${err.message}\n${errors.join('\n')}\n${await page.locator('.answer-diagram').innerText()}`); });
      expect(await page.locator('iframe').getAttribute('sandbox')).toBe('allow-scripts');
      await page.evaluate(() => document.documentElement.dataset.theme = 'light');
      await page.waitForFunction(() => document.querySelector('iframe')?.srcdoc.includes('background:#ffffff'));
      await frame.locator('svg').waitFor();
      expect(await frame.locator('body').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(255, 255, 255)');
      answer = '```mermaid\nthis is not a diagram\n```';
      await page.reload(); await page.getByText('Diagram unavailable.', { exact: false }).waitFor();
      await page.getByText('Diagram source', { exact: true }).click();
      expect(await page.getByText('this is not a diagram', { exact: true }).count()).toBe(1);
    } finally { await page.close(); }
  }, 20_000);
});
