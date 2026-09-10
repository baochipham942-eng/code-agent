import './remote-only.mjs';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, openSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

// Prerequisite: an isolated data/config directory provisioned with an existing model credential.
// This harness never copies credentials, disables approval policy, or mocks the Neo engine.
const root=resolve('../..');
const directory=resolve(root,'.reports/companion-acceptance');
assert(existsSync(resolve(directory,'data/config.json')),'ISOLATED_CONFIG_REQUIRED');
mkdirSync(directory,{recursive:true});
const port=18189; const base=`http://127.0.0.1:${port}`;
const keychainBridge=process.env.NEO_TEST_COMPANION_KEYCHAIN==='1';
const preload=resolve(directory,'keychain-test-port.cjs');
if(keychainBridge)writeFileSync(preload,`const {createRequire}=require('node:module'); const r=createRequire(${JSON.stringify(resolve(root,'package.json'))}); const original=r('keytar'); let identity=null; const bridge={...original,getPassword:(s,a)=>s==='dev.neo.companion.host.v1'?Promise.resolve(identity):original.getPassword(s,a),setPassword:(s,a,v)=>s==='dev.neo.companion.host.v1'?Promise.resolve(identity=v):original.setPassword(s,a,v)};r.cache[r.resolve('keytar')].exports=bridge;`);
const child=spawn(process.execPath,[...(keychainBridge?['--require',preload]:[]),resolve(root,'dist/web/webServer.bundle.cjs')],{
  cwd:directory,env:{...process.env,CODE_AGENT_DATA_DIR:resolve(directory,'data'),CODE_AGENT_E2E:'1',WEB_PORT:String(port)},
  stdio:['ignore',openSync(resolve(directory,'host.log'),'w'),openSync(resolve(directory,'host-error.log'),'w')],
});
let browser,http,auth,db,page;const checks=[];
function pass(name){checks.push(name);console.log('PASS',name);}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function api(path,body){const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${auth}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});const value=await response.json();assert(response.ok,`${path}: ${response.status} ${JSON.stringify(value.error ?? value).slice(0,500)}`);return value;}
try {
  for(let n=0;n<60;n++){
    if(child.exitCode!==null)throw new Error('HOST_EXITED');
    try{if((await fetch(base+'/api/health')).ok)break;}catch{}
    if(n===59)throw new Error('HOST_START_TIMEOUT');await pause(1000);
  }
  auth=readFileSync(resolve(directory,'.dev-token'),'utf8').trim();
  const project=resolve(directory,'project');mkdirSync(project,{recursive:true});
  db=new Database(resolve(directory,'data/code-agent.db'),{readonly:true});
  const sessionTitle=`Mobile real Neo acceptance ${Date.now()}`;
  const created=await api('/api/sessions',{title:sessionTitle,workingDirectory:project});
  assert(created.success); const sessionId=created.data.id;
  const mode=await api('/api/domain/agent/setSessionPermissionMode',{payload:{sessionId,mode:'readOnly'}});
  assert(mode.success && mode.data.mode==='readOnly','REAL_SESSION_APPROVAL_MODE_REQUIRED');
  const invited=await api('/api/companion/manage',{action:'invite',scope:[sessionId]});
  assert.equal(invited.kind,'invitation');let invitation=invited.invitation;
  await build({stdin:{contents:`
    import { createRoot } from 'react-dom/client';
    import { MobileRoot } from './src/app/MobileRoot';
    import './src/styles.css';
    createRoot(document.getElementById('root')).render(<MobileRoot fixtures={false} ports={{
      preferences:{get:async()=>localStorage.getItem('drafts'),set:async v=>localStorage.setItem('drafts',v)},
      companion:{read:()=>window.lanRead(),write:v=>window.lanWrite(v),scan:()=>window.lanScan(),post:(url,body)=>window.lanPost(url,body)},
      appInfo:{read:async()=>({version:'acceptance',build:'real-host'})},
      lifecycle:{subscribe:async()=>()=>{},leave:async()=>{}},keyboard:{subscribe:async()=>()=>{},hide:async()=>{}},systemBars:{setStyle:async()=>{}}
    }}/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',outfile:resolve(directory,'library-mobile.js')});
  http=createServer((req,res)=>{if(req.url==='/library-mobile.js'||req.url==='/library-mobile.css'){res.setHeader('content-type',req.url.endsWith('.css')?'text/css':'application/javascript');res.end(readFileSync(resolve(directory,req.url.slice(1))));}else res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/library-mobile.css"><div id="root"></div><script src="/library-mobile.js"></script>');});
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:393,height:852},locale:'zh-CN'});
  page.setDefaultTimeout(30000);
  const waitFor = locator => Promise.race([locator.waitFor(), page.getByText('任务失败',{exact:true}).waitFor().then(()=>{throw new Error('REAL_NEO_RUN_FAILED');})]);
  let storage=null,loseReceipt=false;const errors=[],wire=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.exposeFunction('lanRead',()=>storage);await page.exposeFunction('lanWrite',v=>{storage=v;});
  await page.exposeFunction('lanScan',()=>JSON.stringify(invitation));
  await page.exposeFunction('lanPost',async(url,body)=>{
    assert.equal(new URL(url).origin,invitation.endpoint);wire.push(JSON.stringify(body));
    const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),redirect:'error'});
    assert(response.ok);const data=await response.json();wire.push(JSON.stringify(data));
    if(loseReceipt&&storage&&JSON.parse(storage).pending?.action==='approval.respond'){loseReceipt=false;throw new Error('INJECTED_LOST_APPROVAL_RECEIPT');}
    return data;
  });
  await page.goto(`http://127.0.0.1:${http.address().port}`);
  await page.getByTestId('open-drawer').click();await page.getByRole('button',{name:'连接电脑',exact:true}).click();
  await page.getByRole('button',{name:'扫描电脑二维码',exact:true}).click();await page.getByText('已连接电脑',{exact:true}).last().waitFor();
  assert.equal(await page.getByRole('dialog').count(),0);await page.getByText(sessionTitle,{exact:true}).first().waitFor();pass('pair-production-mobile-to-real-Neo-host');
  const createdTitle=`Phone created ${Date.now()}`; const renamedTitle=`Phone renamed ${Date.now()}`;
  const projectId=db.prepare('SELECT project_id FROM sessions WHERE id=?').get(sessionId).project_id;
  await page.getByTestId('open-drawer').click();
  await page.locator('.drawer').getByRole('button',{name:'项目',exact:true}).click();
  await page.getByText('需要在电脑连接手机设置中勾选此项目，再扫码更新授权，才能新建会话。',{exact:true}).waitFor();
  pass('session-only-pairing-cannot-create-project-conversations');
  const projectInvite=await api('/api/companion/manage',{action:'invite',scope:[`project:${projectId}`]});
  invitation=projectInvite.invitation;
  await page.getByRole('dialog').getByRole('button',{name:'关闭弹层',exact:true}).click();
  await page.getByRole('button',{name:'连接电脑',exact:true}).click();
  await page.getByRole('button',{name:'扫描电脑二维码',exact:true}).click();
  await page.getByRole('button',{name:'进入会话',exact:true}).click();
  await page.getByTestId('open-drawer').click();
  await page.getByRole('button',{name:sessionTitle,exact:true}).click();
  await page.getByTestId('draft').fill('original session draft');
  await page.getByTestId('open-drawer').click();
  await page.getByRole('button',{name:'新会话',exact:true}).last().click();
  await page.locator('#new-title').fill(createdTitle);
  await page.getByRole('button',{name:'新会话',exact:true}).last().click();
  await page.getByRole('dialog').waitFor({state:'detached'});
  await page.locator('.drawer').waitFor({state:'detached'});
  await page.waitForFunction(title=>document.querySelector('.topbar strong')?.textContent===title,createdTitle);
  const newSession=db.prepare('SELECT id,project_id FROM sessions WHERE title=? AND is_deleted=0').get(createdTitle);
  assert(newSession && newSession.project_id===projectId);const createdId=newSession.id;
  assert.equal(await page.getByTestId('draft').inputValue(),'');
  await page.getByTestId('draft').fill('second session draft');
  await page.getByTestId('open-drawer').click();
  await page.getByRole('button',{name:sessionTitle,exact:true}).click();
  assert.equal(await page.getByTestId('draft').inputValue(),'original session draft');
  await page.getByTestId('open-drawer').click();
  await page.getByRole('button',{name:createdTitle,exact:true}).click();
  assert.equal(await page.getByTestId('draft').inputValue(),'second session draft');
  pass('create-real-project-session-and-switch-with-isolated-drafts');
  await page.getByTestId('open-more').click();
  await page.locator('#session-title').fill(renamedTitle);
  await page.getByRole('button',{name:'保存名称',exact:true}).click();
  await page.waitForFunction(title=>document.querySelector('.topbar strong')?.textContent===title,renamedTitle);
  assert.equal(db.prepare('SELECT title FROM sessions WHERE id=?').get(createdId).title,renamedTitle);
  pass('rename-persists-in-desktop-database');
  await page.reload();
  await page.getByTestId('open-drawer').click();
  await page.getByRole('button',{name:renamedTitle,exact:true}).click();
  assert.equal(await page.getByTestId('draft').inputValue(),'second session draft');
  await page.getByTestId('open-more').click();
  await page.getByRole('button',{name:'归档会话',exact:true}).click();
  await page.waitForTimeout(1500);
  assert.equal(db.prepare('SELECT status FROM sessions WHERE id=?').get(createdId).status,'archived');
  pass('restart-keeps-drafts-and-archive-updates-desktop');
  if(await page.getByRole('dialog').count())await page.getByRole('dialog').getByRole('button',{name:'关闭弹层',exact:true}).click();
  await page.getByTestId('open-more').click();
  await page.getByRole('button',{name:'取消归档',exact:true}).click();
  await page.waitForTimeout(1500);
  assert.notEqual(db.prepare('SELECT status FROM sessions WHERE id=?').get(createdId).status,'archived');
  if(await page.getByRole('dialog').count())await page.getByRole('dialog').getByRole('button',{name:'关闭弹层',exact:true}).click();
  await page.getByTestId('open-more').click();
  const options=await page.locator('#model-select option').evaluateAll(nodes=>nodes.map(n=>({value:n.value,label:n.textContent})));
  assert(options.length>0);pass('model-options-come-from-configured-desktop-catalogue');
  if(options.length>1){
    const value=await page.locator('#model-select').inputValue();const other=options.find(o=>o.value!==value);
    await page.locator('#model-select').selectOption(other.value);await page.getByRole('button',{name:'使用此模型',exact:true}).click();
    await page.waitForTimeout(1500);
    const [provider,model]=JSON.parse(other.value);const row=db.prepare('SELECT model_provider,model_name,metadata FROM sessions WHERE id=?').get(createdId);
    assert.equal(row.model_provider,provider);assert.equal(row.model_name,model);assert(JSON.parse(row.metadata).modelOverride);pass('model-choice-persists-with-desktop-override-marker');
  }
  if(await page.getByRole('dialog').count())await page.getByRole('dialog').getByRole('button',{name:'关闭弹层',exact:true}).click();
  await page.getByTestId('open-more').click();await page.getByRole('button',{name:'删除会话',exact:true}).click();
  assert.equal(db.prepare('SELECT is_deleted FROM sessions WHERE id=?').get(createdId).is_deleted,0);
  await page.getByRole('button',{name:'确认删除',exact:true}).click();await page.waitForTimeout(1500);
  assert.equal(db.prepare('SELECT is_deleted FROM sessions WHERE id=?').get(createdId).is_deleted,1);
  assert.equal(JSON.parse(storage).pending,undefined);pass('explicit-delete-persists-and-command-receipt-clears');
  assert.deepEqual(errors,[]);pass('no-browser-errors');
  const filename='not-applicable';
  const output={keychainBridge,checks,passed:checks.length,failed:0,skipped:0,sessionId,filename,scope:'Production mobile UI + real LAN Noise + full Neo Host project/session/model services and SQLite. Scanner/storage use browser test ports. No physical-phone or speech evidence.'};
  writeFileSync(resolve(directory,'library-result.json'),JSON.stringify(output,null,2));console.log(JSON.stringify(output));
} catch(error){if(page){await page.screenshot({path:resolve(directory,'library-failure.png')});writeFileSync(resolve(directory,'library-failure.txt'),await page.locator('body').innerText());}writeFileSync(resolve(directory,'failure.json'),JSON.stringify({checks,error:String(error),passed:checks.length,failed:1},null,2));throw error;}
finally {
  db?.close();await browser?.close();if(http){http.closeAllConnections();await new Promise(resolve=>http.close(resolve));}
  child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(5000)]);if(child.exitCode===null)child.kill('SIGKILL');
}
