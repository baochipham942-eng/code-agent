import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.goto('http://localhost:8182/');
await p.waitForSelector('.h-screen', { timeout: 30000 });
await p.waitForTimeout(2500);
const out = await p.evaluate(async () => {
  const api = window.codeAgentDomainAPI || window.domainAPI;
  const before = await api.invoke('voice', 'voiceprintOverview');
  let prepared = null, err = null;
  try { prepared = await api.invoke('voice', 'voiceprintPrepareModel'); }
  catch (e) { err = String(e); }
  return { before, prepared, err };
});
console.log(JSON.stringify(out, null, 1));
await b.close();
