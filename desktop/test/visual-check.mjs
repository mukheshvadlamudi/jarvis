import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { makeCtx } from '../../server/test/helpers.ts';
const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../..');
const web = resolve(root, 'web/src').replaceAll('\\', '/');
const ctx = makeCtx();
const setup = (await ctx.req('GET', '/api/setup')).json;
const css = ['tokens', 'app', 'hud'].map((name) => readFileSync(resolve(web, 'styles', name + '.css'), 'utf8')).join('\n').replace(/url\([^)]+\)/g, 'url(/font.woff2)');
const entry = `import {createElement as h} from 'react';import {createRoot} from 'react-dom/client';import Settings from '${web}/pages/Settings.tsx';import Setup from '${web}/pages/Setup.tsx';createRoot(document.getElementById('root')).render(h(location.pathname==='/setup'?Setup:Settings));`;
const result = await build({ configFile: false, root: resolve(root, 'web'), logLevel: 'silent', plugins: [react(), { name: 'desktop-ui-check', enforce: 'pre', resolveId: (id) => id === 'virtual:desktop-ui' ? id : undefined, load: (id) => {
  if (id === 'virtual:desktop-ui') return entry;
  if (id.replaceAll('\\','/').endsWith('/voice/engine.ts')) return readFileSync(id,'utf8').replace(/new URL\('\.\/(?:tts|stt|turn)\.worker\.ts', import\.meta\.url\)/g, "new URL('about:blank')");
}}], build: { write: false, minify: false, rolldownOptions: { input: 'virtual:desktop-ui', external: ['@ricky0123/vad-web'], output: { codeSplitting: false } } } });
const chunks = result.output.filter((v) => v.type === 'chunk');
const bundle = chunks.map((v) => v.code).join('\n');
const out = resolve(import.meta.dirname, 'screenshots'); mkdirSync(out, { recursive: true });
const browser = await chromium.launch(process.platform === 'win32' ? {channel:'msedge'} : {});
try {
  for (const width of [375,1440]) for (const theme of ['dark','light']) {
    ctx.s.config.update({agents:{claude:{chrome:false}}});
    const page = await browser.newPage({ viewport:{width,height:width===375?812:900}, colorScheme: theme });
    const errors=[];page.on('pageerror',(e)=>errors.push(e.message));
    await page.addInitScript(() => {
      let prefs={enabled:true,shortcut:'Control+Space',mode:'ask',registered:'Control+Space',warning:''};
      window.jarvisDesktop={platform:'win32',anywhereSettings:async(patch)=>{prefs={...prefs,...patch};return prefs;},login:async()=>({ok:true,message:'mock'}),openPath:async()=>'',info:async()=>({}),onCapture:()=>()=>{}};
      window.EventSource=class {addEventListener(){} close(){}};
    });
    await page.route('http://desktop.test/**',async(route)=>{
      const request=route.request(),path=new URL(request.url()).pathname;
      if(path==='/bundle.js')return route.fulfill({contentType:'text/javascript',body:bundle});
      if(path==='/font.woff2')return route.fulfill({contentType:'font/woff2',body:readFileSync(resolve(dirname(require.resolve('geist/font')),'fonts/geist-sans/Geist-Variable.woff2'))});
      if(path.startsWith('/api/'))return route.fulfill({json:path==='/api/setup'?setup:(await ctx.req(request.method(),path,request.postDataJSON()??undefined)).json});
      return route.fulfill({contentType:'text/html',body:`<html data-theme="${theme}"><style>${css}#root{max-width:1200px;margin:auto}</style><div id="root"></div><script type="module" src="/bundle.js"></script></html>`});
    });
    await page.goto('http://desktop.test/settings');
    const anywhere=page.getByRole('region',{name:'Jarvis anywhere',exact:true});await anywhere.waitFor();
    await page.getByRole('switch',{name:'Claude can use your Chrome',exact:true}).click();
    const saved=page.waitForResponse(r=>r.url().endsWith('/api/settings')&&r.request().method()==='PUT');
    await page.getByRole('button',{name:'Save changes',exact:true}).click();await saved;
    assert.equal(ctx.s.config.get().agents.claude.chrome,true);
    await anywhere.getByRole('button',{name:'Dictate',exact:true}).click();
    await anywhere.screenshot({path:resolve(out,`anywhere-${width}-${theme}.png`)});
    await page.screenshot({path:resolve(out,`settings-${width}-${theme}.png`),fullPage:true});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Settings horizontal overflow');
    await page.goto('http://desktop.test/setup');
    await page.getByRole('link',{name:'Install Claude in Chrome',exact:true}).waitFor();
    await page.screenshot({path:resolve(out,`setup-${width}-${theme}.png`),fullPage:true});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Setup horizontal overflow');
    assert.deepEqual(errors,[]);
    await page.close();
  }
  for(const width of [375,560])for(const theme of ['dark','light']){
    const page=await browser.newPage({viewport:{width,height:180},colorScheme:theme});
    const errors=[];page.on('pageerror',(e)=>errors.push(e.message));
    await page.addInitScript(()=>{window.jarvisDesktop={anywhereSettings:async()=>({mode:'dictate'}),onAnywhere:(fn)=>{window.overlayEvent=fn;},closeAnywhere:async()=>{window.didClose=true;},releaseAnywhereFocus:async()=>{},openAnywhere:async()=>{},pasteAnywhere:async()=>({ok:true})};});
    await page.route('http://overlay.test/**',async(route)=>{const path=new URL(route.request().url()).pathname;const file=resolve(root,'desktop/overlay-build',path.replace('/__desktop/',''));return route.fulfill({path:file});});
    await page.goto('http://overlay.test/__desktop/overlay.html');
    await page.getByRole('button',{name:'Ask Jarvis',exact:true}).waitFor();
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('button',{name:'Dictate',exact:true}).getAttribute('aria-pressed'),'true');
    await page.screenshot({path:resolve(out,`overlay-${width}-${theme}.png`)});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.keyboard.press('Escape');assert(await page.evaluate(()=>window.didClose));assert.deepEqual(errors,[]);
    await page.close();
  }
  console.log('Visual checks passed: Settings, Setup and overlay, two widths, both themes; no horizontal overflow or page errors.');
}finally{await browser.close();await ctx.close();}



