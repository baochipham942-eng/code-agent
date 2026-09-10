import './remote-only.mjs';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const dir=resolve('.reports/voice-ui');mkdirSync(dir,{recursive:true});
await build({stdin:{contents:`
import {createRoot} from 'react-dom/client'; import {VoiceInput} from './src/features/sessions/VoiceInput'; import {messages} from './src/i18n';
const root=createRoot(document.getElementById('root'));
window.calls=[];window.stops=0;window.holdStop=false;window.holdStart=false;window.denied=false;
const recorder={start:async()=>{if(window.denied)throw new Error('MICROPHONE_DENIED');if(window.holdStart)await new Promise(r=>window.releaseStart=r);},stop:async()=>{window.stops++;if(window.holdStop)await new Promise(r=>window.releaseStop=r);return {audioData:'YXVkaW8=',mimeType:'audio/aac',durationMs:1000};}};
window.mount=(id='a')=>root.render(<VoiceInput key={id} recorder={recorder} text={messages('zh')} disabled={false} pending={false} outcome={null} transcribe={async audio=>{window.calls.push({id,audio});}}/>);
window.mount();`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',outfile:resolve(dir,'ui.js')});
const server=createServer((req,res)=>res.end(req.url==='/ui.js'?readFileSync(resolve(dir,'ui.js')):'<div id="root"></div><script src="/ui.js"></script>'));
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true});const page=await browser.newPage();const checks=[];
try{
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.getByRole('button',{name:'语音输入',exact:true}).click();await page.evaluate(()=>window.holdStop=true);
 await page.getByRole('button',{name:'停止录音并转写',exact:true}).click();assert.equal(await page.evaluate(()=>window.calls.length),0);
 await page.evaluate(()=>window.releaseStop());await page.getByRole('button',{name:'重试',exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.stops),1);assert.equal(await page.evaluate(()=>window.calls.length),1);checks.push('transcribes-only-after-stop-resolves');
 await page.getByRole('button',{name:'重试',exact:true}).click();assert.equal(await page.evaluate(()=>window.calls.length),2);assert.equal(await page.evaluate(()=>window.stops),1);checks.push('retry-reuses-stopped-audio');
 await page.evaluate(()=>{window.calls=[];window.mount('b');});await page.getByRole('button',{name:'语音输入',exact:true}).click();await page.getByRole('button',{name:'停止录音并转写',exact:true}).click();
 await page.evaluate(()=>window.mount('c'));await page.getByRole('button',{name:'语音输入',exact:true}).waitFor();await page.evaluate(()=>window.releaseStop());await page.waitForTimeout(30);assert.equal(await page.evaluate(()=>window.calls.length),0);checks.push('switch-during-stop-discards-originating-audio');
 await page.evaluate(()=>{window.holdStop=false;window.holdStart=true;});const previous=await page.evaluate(()=>window.stops);
 await page.getByRole('button',{name:'语音输入',exact:true}).click();await page.evaluate(()=>window.mount('d'));await page.getByRole('button',{name:'语音输入',exact:true}).waitFor();await page.evaluate(()=>window.releaseStart());await page.waitForTimeout(30);assert.equal(await page.evaluate(()=>window.stops),previous+1);assert.equal(await page.evaluate(()=>window.calls.length),0);checks.push('switch-during-permission-start-releases-recorder');
 await page.evaluate(()=>{window.denied=true;window.holdStart=false;});await page.getByRole('button',{name:'语音输入',exact:true}).click();await page.getByText('麦克风未允许，请在系统设置中允许 Neo 录音。',{exact:true}).waitFor();checks.push('permission-denied-has-recovery-copy');
 writeFileSync(resolve(dir,'result.json'),JSON.stringify({passed:checks.length,failed:0,skipped:0,checks,scope:'Chromium with controlled recorder promises; not native microphone or Groq evidence'},null,2));console.log(`VOICE_UI ${checks.length} passed / 0 failed / 0 skipped`);
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
