import { _electron } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const runtime=resolve(import.meta.dirname,'.runtime');mkdirSync(runtime,{recursive:true});
writeFileSync(resolve(runtime,'shell.mjs'), `
import {app,BrowserWindow,globalShortcut} from 'electron';
import {createServer} from 'node:http';
import {installAnywhere} from '../../anywhere.mjs';
import {resolve} from 'node:path';
app.setPath('userData',resolve(import.meta.dirname,'user-data'));
let trigger;
globalShortcut.register=(key,fn)=>{trigger=fn;return true;};
app.on('browser-window-created',(_event,win)=>{const send=win.webContents.send.bind(win.webContents);win.webContents.send=(channel,msg)=>{if(channel==='jarvis:anywhere'&&msg.action==='start')return;return send(channel,msg);};});
await app.whenReady();
const server=createServer((_req,res)=>{res.end('<html><body>Desktop test</body></html>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+server.address().port;
await installAnywhere({here:resolve(import.meta.dirname,'../..'),userData:app.getPath('userData'),origin,token:'',packaged:true,showWindow:()=>{}});
globalThis.testReady=true;globalThis.openOverlay=()=>trigger();
app.on('will-quit',()=>server.close());
`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const electron=await _electron.launch({args:[resolve(runtime,'shell.mjs')],env});
try{
  await electron.evaluate(async()=>{while(!globalThis.testReady)await new Promise(r=>setTimeout(r,30));globalThis.openOverlay();});
  const page=await electron.firstWindow();await page.waitForLoadState('domcontentloaded');
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.getByRole('button',{name:'Ask Jarvis',exact:true}).waitFor();
  const prefs=await page.evaluate(()=>window.jarvisDesktop.anywhereSettings());assert.equal(prefs.registered,'Control+Space');
  await page.keyboard.press('Tab');assert.equal(await page.getByRole('button',{name:'Dictate',exact:true}).getAttribute('aria-pressed'),'true');
  await page.screenshot({path:resolve(import.meta.dirname,'screenshots/electron-overlay.png')});
  assert.deepEqual(errors,[]);console.log('Electron smoke passed: isolated HTTP protocol, bundled overlay, preload IPC and remembered Tab mode. No microphone or paste used.');
}finally{await electron.close();}
