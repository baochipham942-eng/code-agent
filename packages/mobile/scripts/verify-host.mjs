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
const child=spawn(process.execPath,[resolve(root,'dist/web/webServer.bundle.cjs')],{
  cwd:directory,env:{...process.env,CODE_AGENT_DATA_DIR:resolve(directory,'data'),CODE_AGENT_E2E:'1',WEB_PORT:String(port)},
  stdio:['ignore',openSync(resolve(directory,'host.log'),'w'),openSync(resolve(directory,'host-error.log'),'w')],
});
let browser,http,auth,db;const checks=[];
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
  const created=await api('/api/sessions',{title:'Mobile real Neo acceptance',workingDirectory:project});
  assert(created.success); const sessionId=created.data.id;
  const mode=await api('/api/domain/agent/setSessionPermissionMode',{payload:{sessionId,mode:'readOnly'}});
  assert(mode.success && mode.data.mode==='readOnly','REAL_SESSION_APPROVAL_MODE_REQUIRED');
  const invited=await api('/api/companion/manage',{action:'invite',scope:[sessionId]});
  assert.equal(invited.kind,'invitation');const invitation=invited.invitation;
  await build({stdin:{contents:`
    import { createRoot } from 'react-dom/client';
    import { MobileRoot } from './src/app/MobileRoot';
    import './src/styles.css';
    createRoot(document.getElementById('root')).render(<MobileRoot fixtures={false} ports={{
      preferences:{get:async()=>localStorage.getItem('drafts'),set:async v=>localStorage.setItem('drafts',v)},
      companion:{read:()=>window.lanRead(),write:v=>window.lanWrite(v),scan:()=>window.lanScan(),post:(url,body)=>window.lanPost(url,body)},
      appInfo:{read:async()=>({version:'acceptance',build:'real-host'})},
      lifecycle:{subscribe:async()=>()=>{},leave:async()=>{}},keyboard:{subscribe:async()=>()=>{},hide:async()=>{}},systemBars:{setStyle:async()=>{}}
    }}/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',outfile:resolve(directory,'mobile.js')});
  http=createServer((req,res)=>{if(req.url==='/mobile.js'||req.url==='/mobile.css'){res.setHeader('content-type',req.url.endsWith('.css')?'text/css':'application/javascript');res.end(readFileSync(resolve(directory,req.url.slice(1))));}else res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/mobile.css"><div id="root"></div><script src="/mobile.js"></script>');});
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:393,height:852},locale:'zh-CN'});
  page.setDefaultTimeout(120000);
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
  assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await page.locator('.topbar strong').innerText(),'共享会话 1');pass('pair-production-mobile-to-real-Neo-host');
  const filename=`mobile-acceptance-${Date.now()}.txt`;const marker='NEO_MOBILE_REAL_TASK_OK';
  await page.getByTestId('draft').fill(`Use write_file to create ${filename} in this project containing exactly ${marker}. Do not run shell commands or access any other paths. Wait for my approval when requested, then report the created filename.`);
  await page.getByTestId('send').click();await waitFor(page.getByRole('button',{name:'停止任务',exact:true}));pass('durable-run-id-reaches-mobile-stop-control');
  const allow=page.getByRole('button',{name:'允许这一次',exact:true});await Promise.race([waitFor(allow), page.getByText('任务已完成',{exact:true}).waitFor().then(()=>{throw new Error('TASK_FINISHED_WITHOUT_REQUIRED_APPROVAL');})]);
  assert(!existsSync(resolve(project,filename)),'file must not exist before real approval');
  await page.screenshot({path:resolve(directory,'approval.png')});pass('real-model-write-pauses-before-file-side-effect');
  const projected=db.prepare("SELECT payload_json FROM companion_events WHERE session_id=? AND kind='approval' ORDER BY seq DESC LIMIT 1").get(sessionId);
  const operation=JSON.parse(JSON.parse(projected.payload_json).preview);
  assert((await page.locator('.approval-card').last().innerText()).includes(filename));
  assert.equal(operation.type,'file_write');assert.equal(operation.tool,'Write');
  assert.equal(resolve(project,operation.details.path ?? operation.details.filePath),resolve(project,filename));
  loseReceipt=true;await allow.click();await page.getByText('正在核对电脑是否已接收，请勿重复发送',{exact:true}).waitFor();
  await page.reload();await waitFor(page.getByText('任务已完成',{exact:true}));
  assert.equal(readFileSync(resolve(project,filename),'utf8').trim(),marker);pass('mobile-approval-survives-lost-receipt-and-real-file-is-created');
  const saved=JSON.parse(storage);assert(!saved.pending);pass('pending-command-cleared-after-authoritative-reconciliation');
  const committed=db.prepare("SELECT payload_json FROM companion_events WHERE session_id=? AND kind='message'").all(sessionId).map(row=>JSON.parse(row.payload_json)).filter(row=>row.role==='assistant');
  const rendered=await page.locator('.lan-message:not(.from-user)').allTextContents();
  for(const content of new Set(committed.map(row=>row.content))) assert.equal(rendered.filter(value=>value===content).length,committed.filter(row=>row.content===content).length,'stream and committed reply must share one visible row');
  pass('real-stream-and-durable-message-render-once');
  const detail=await api('/api/sessions/'+sessionId);assert(JSON.stringify(detail).includes(filename),'desktop session must contain real result');
  assert(!wire.join('\n').includes(marker));assert.deepEqual(errors,[]);pass('encrypted-wire-and-no-page-errors');
  await page.screenshot({path:resolve(directory,'completed.png')});
  for (const action of ['deny', 'stop']) {
    const blockedFile = `mobile-${action}-${Date.now()}.txt`;
    await page.getByTestId('draft').fill(`Use Write to create ${blockedFile} containing ${marker}. Only access this project. If denied or cancelled, stop without retrying or using another tool.`);
    await page.getByTestId('send').click();
    await waitFor(page.getByRole('button',{name:'允许这一次',exact:true}));
    assert(!existsSync(resolve(project,blockedFile)));
    await page.getByRole('button',{name:action==='deny'?'拒绝':'停止任务',exact:true}).click();
    if(action==='stop') await page.getByText('任务已停止',{exact:true}).waitFor({timeout:10000});
    else await waitFor(page.getByText('任务已完成',{exact:true}));
    assert(!existsSync(resolve(project,blockedFile)),'denied/stopped operation must not write');
    const decision=db.prepare('SELECT status FROM companion_decisions WHERE session_id=? ORDER BY rowid DESC LIMIT 1').get(sessionId);
    assert.notEqual(decision.status,'pending');
    pass(`real-mobile-${action}-prevents-file-side-effect`);
    await page.screenshot({path:resolve(directory,`${action}.png`)});
  }
  const output={checks,passed:checks.length,failed:0,skipped:0,sessionId,filename,scope:'Production mobile UI + real LAN Noise + full Neo webServer, actual model API/tool executor/approval resolver/SQLite/file. Scanner and mobile storage are bridged test ports; no physical-phone evidence.'};
  writeFileSync(resolve(directory,'result.json'),JSON.stringify(output,null,2));console.log(JSON.stringify(output));
} catch(error){writeFileSync(resolve(directory,'failure.json'),JSON.stringify({checks,error:String(error),passed:checks.length,failed:1},null,2));throw error;}
finally {
  db?.close();await browser?.close();if(http){http.closeAllConnections();await new Promise(resolve=>http.close(resolve));}
  child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(5000)]);if(child.exitCode===null)child.kill('SIGKILL');
}
