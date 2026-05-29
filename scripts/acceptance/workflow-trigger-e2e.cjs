const { chromium } = require('playwright');
const BASE = 'http://localhost:8190';
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  p.on('console', m => { if (m.type()==='error') errors.push(m.text()); });
  await p.goto(BASE, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#root', { timeout: 15000 });
  await p.waitForTimeout(2500);
  await p.evaluate(() => { const r=Array.from(document.querySelectorAll('div,button,a,li')).find(el=>(el.textContent||'').includes('CLI Session')); if(r) r.click(); });
  const input = await p.waitForSelector('textarea', { timeout: 10000 });
  await p.waitForTimeout(1000);
  await input.click();
  await input.type('/workflow', { delay: 30 });
  await p.waitForTimeout(800);
  const popoverHasWorkflow = await p.evaluate(() => document.body.innerText.includes('让模型写 JS 脚本编排'));
  console.log('popover shows /workflow entry?', popoverHasWorkflow);
  // 点 workflow 行（含描述文案）
  const clicked = await p.evaluate(() => {
    const row = Array.from(document.querySelectorAll('div,button,li')).find(el => (el.textContent||'').includes('让模型写 JS 脚本编排') && (el.textContent||'').length < 120);
    if (row) { row.click(); return true; }
    return false;
  });
  await p.waitForTimeout(600);
  const val = await p.evaluate(() => { const t=document.querySelector('textarea'); return t ? t.value : '(none)'; });
  console.log('clicked?', clicked, '| input value:', JSON.stringify(val));
  const pass = popoverHasWorkflow && clicked && val.trim() === '/workflow';
  console.log('console errors:', errors.length);
  console.log(pass ? 'TRIGGER E2E PASS ✅' : 'TRIGGER E2E FAIL ❌');
  await b.close();
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('ERR', e); process.exit(1); });
