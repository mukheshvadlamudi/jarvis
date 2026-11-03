import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';
import { chromium } from 'playwright';
import { resolve } from 'node:path';

test('overlay asks, continues its conversation, dictates and closes without real audio or native paste', async () => {
  const root=resolve(import.meta.dirname,'..');
  const voiceStub=`export const voice={state:{status:'off',error:null,outcome:''},subscribe(fn){this.listener=fn;},setPrefs(){},async start(){this.state.status='listening';this.listener?.();},async stop(){this.state.status='off';},onUtterance:null};window.testVoice=voice;`;
  const result=await build({root,configFile:false,logLevel:'silent',plugins:[{name:'mock-local-microphone',enforce:'pre',load(id){if(id.replaceAll('\\','/').endsWith('/voice/engine.ts'))return voiceStub;}}],build:{write:false,rollupOptions:{input:resolve(root,'overlay.html')}}});
  const files=new Map(result.output.map(file=>[file.fileName,file.type==='asset'?file.source:file.code]));
  const browser=await chromium.launch(process.platform==='win32'?{channel:'msedge'}:{});
  const page=await browser.newPage();
  const sent=[];
  try{
    await page.addInitScript(()=>{
      window.jarvisDesktop={
        onAnywhere(fn){window.overlayEvent=fn;},
        async anywhereSettings(patch){window.savedMode=patch.mode;return patch;},
        async expandAnywhere(){},async releaseAnywhereFocus(){window.focusReleased=true;},
        async closeAnywhere(){window.didClose=true;window.overlayEvent({action:'close'});},
        async openAnywhere(id){window.opened=id;},
        async pasteAnywhere(text){window.pasted=text;return {ok:true};},
      };
    });
    await page.route('http://overlay.test/**',async route=>{
      const request=route.request(),path=new URL(request.url()).pathname;
      if(path.startsWith('/api/')){
        if(request.method()==='POST'){sent.push({path,body:request.postDataJSON()});return route.fulfill({json:{conversation:{id:'c_overlay'}}});}
        return route.fulfill({json:{active:false,approvals:[],conversation:{status:'done'},runs:[{events:[{kind:'message',payload:{role:'assistant',text:'The backup completed.'}}]}]}});
      }
      const file=path==='/'?'overlay.html':path.slice(1);
      return route.fulfill({contentType:file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript',body:files.get(file)});
    });
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://overlay.test/');await page.getByRole('button',{name:'Ask Jarvis',exact:true}).waitFor();
    await page.evaluate(()=>{window.overlayEvent({action:'start',mode:'ask'});window.testVoice.onUtterance('Check the backup');});
    await page.getByText('The backup completed.',{exact:true}).waitFor();
    assert.deepEqual(sent[0],{path:'/api/conversations',body:{text:'Check the backup'}});
    assert(await page.evaluate(()=>window.focusReleased));
    await page.getByRole('button',{name:'Open in Jarvis',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.opened),'c_overlay');
    await page.evaluate(()=>{window.overlayEvent({action:'toggle'});window.testVoice.onUtterance('What time?');});
    await page.waitForFunction(()=>document.getElementById('status').textContent==='Answered');
    assert.equal(sent[1].path,'/api/conversations/c_overlay/messages');
    await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>window.savedMode),'dictate');
    await page.evaluate(()=>{window.overlayEvent({action:'start',mode:'dictate'});window.testVoice.onUtterance('Put this in the editor');});
    await page.waitForFunction(()=>window.pasted==='Put this in the editor');
    assert.equal(sent.length,2);
    await page.keyboard.press('Escape');assert(await page.evaluate(()=>window.didClose));
    assert.equal(await page.evaluate(()=>window.testVoice.state.status),'off');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

