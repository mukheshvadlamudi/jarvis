import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
let browser: Browser;
let bundle = '';
const css = ['tokens', 'app', 'hud', 'ask'].map((name) => readFileSync(resolve(root, 'styles', name + '.css'), 'utf8')).join('\n');
beforeAll(async () => {
  const path = root.replaceAll('\\', '/');
  const entry = `import {createElement as h} from 'react'; import {createRoot} from 'react-dom/client'; import {VoiceSettings} from '${path}/components/VoiceSettings.tsx'; import {VoiceDock} from '${path}/components/VoiceDock.tsx'; import {voice} from '${path}/voice/engine.ts'; voice.state = {...voice.state,status:'speaking',natural:'ready',progress:{voice:100,ears:100},turnStatus:'Smart Turn ready - on this device',said:'Your backups are safe. The latest copy was saved this morning.'}; window.voiceTest=voice; voice.onStopAgent=()=>{window.agentStopped=true}; createRoot(document.getElementById('root')).render(h('main',{style:{maxWidth:960,margin:'0 auto',padding:16,paddingBottom:240}},h(VoiceSettings),h(VoiceDock)));`;
  const result = await build({ configFile: false, root: resolve(root, '..'), logLevel: 'silent', plugins: [react(), {
    name: 'voice-browser-fixture', enforce: 'pre',
    resolveId: (id) => id === 'virtual:voice-test' ? id : undefined,
    load: (id) => {
      if (id === 'virtual:voice-test') return entry;
      // UI tests never load model workers or capture audio. Engine logic is tested separately.
      if (id.replaceAll('\\', '/').endsWith('/voice/engine.ts')) return readFileSync(id, 'utf8').replace(/new URL\('\.\/(?:tts|stt|turn)\.worker\.ts', import\.meta\.url\)/g, "new URL('about:blank')");
    },
  }], build: { write: false, minify: false, rolldownOptions: { input: 'virtual:voice-test', external: ['@ricky0123/vad-web'], output: { codeSplitting: false } } } });
  const output = Array.isArray(result) ? result[0].output : 'output' in result ? result.output : [];
  bundle = output.map((item) => item.type === 'chunk' ? item.code : '').join('\n');
  browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge' } : {});
}, 30000);
afterAll(async () => { await browser?.close(); });

describe('Voice controls in the browser', () => {
  it.each([{ width: 375, height: 812 }, { width: 1440, height: 900 }])('renders and operates at $width px in both themes', async (viewport) => {
    for (const theme of ['dark', 'light']) {
      const page = await browser.newPage({ viewport });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('http://voice.test/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
        if (path === '/font.woff2') return route.fulfill({ contentType: 'font/woff2', body: readFileSync(resolve(dirname(require.resolve('geist/font')), 'fonts/geist-sans/Geist-Variable.woff2')) });
        return route.fulfill({ contentType: 'text/html', body: `<html data-theme="${theme}"><style>${css.replace(/url\([^)]+\)/g, 'url(/font.woff2)')}</style><div id="root"></div><script type="module" src="/bundle.js"></script></html>` });
      });
      try {
        await page.goto('http://voice.test/');
        await page.getByRole('button', { name: 'Speaker-safe', exact: true }).waitFor();
        await page.getByRole('button', { name: 'Open voice panel · Speaking', exact: true }).click();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const stop = page.getByRole('button', { name: 'Stop speaking', exact: true });
        const rect = await stop.boundingBox(); expect(rect?.width).toBeGreaterThanOrEqual(44); expect(rect?.height).toBeGreaterThanOrEqual(44);
        mkdirSync(resolve(import.meta.dirname, 'screenshots'), { recursive: true });
        await page.screenshot({ path: resolve(import.meta.dirname, 'screenshots', `voice-${viewport.width}-${theme}.png`) });
        await page.getByRole('button', { name: 'Headset', exact: true }).click();
        expect(await page.getByText('Headset: keep listening and lower the output when you start speaking; use headphones', { exact: true }).count()).toBe(1);
        await page.getByRole('button', { name: 'Simple', exact: true }).click();
        expect(await page.getByText('Simple timing: send after a short silence', { exact: true }).count()).toBe(1);
        await stop.click();
        expect(await page.getByRole('button', { name: 'Stop speaking', exact: true }).count()).toBe(0);
        await page.getByRole('button', { name: 'Mute mic', exact: true }).click();
        expect(await page.getByRole('button', { name: 'Unmute mic', exact: true }).getAttribute('aria-pressed')).toBe('true');
        await page.getByText('Details', { exact: true }).click();
        await page.getByRole('button', { name: 'Stop agent', exact: true }).click();
        expect(await page.evaluate(() => (window as unknown as { agentStopped: boolean }).agentStopped)).toBe(true);
        expect(errors).toEqual([]);
      } finally { await page.close(); }
    }
  }, 30000);
});
