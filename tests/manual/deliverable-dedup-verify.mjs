/* global fetch, setTimeout, window, document, getComputedStyle, console */
// Manual verify: seeded sessions -> deliverable card count + geometry on a real web build (headless only).
// Usage: node tests/manual/deliverable-dedup-verify.mjs <outDir>   (spawns dist/web/webServer.cjs itself)
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

const outDir = process.argv[2] || '/tmp';
mkdirSync(outDir, { recursive: true });
const port = 21000 + (process.pid % 2000);
const base = `http://127.0.0.1:${port}`;
const home = mkdtempSync(path.join(os.tmpdir(), 'dedup-verify-'));
const server = spawn('node', ['dist/web/webServer.cjs'], {
  detached: true,
  stdio: 'ignore',
  env: { ...process.env, CODE_AGENT_E2E: '1', CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE: '1',
    WEB_HOST: '127.0.0.1', WEB_PORT: String(port), HOME: home, CODE_AGENT_HOME: home, CODE_AGENT_DATA_DIR: path.join(home, 'data') },
});
const stop = () => { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* already gone */ } };
process.on('exit', stop);

async function waitUp() {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(base + '/'); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not start');
}

const WORK = '/Users/leo/work/dedup-demo';
let seq = 0;
const call = (name, file, extra = {}) => {
  const id = `tc-${++seq}`;
  return { id, name, arguments: { file_path: file, ...extra },
    result: { toolCallId: id, success: true, output: `${name} ok`, outputPath: file } };
};
const user = (t, ts) => ({ id: `u-${++seq}`, role: 'user', content: t, timestamp: ts });
const asst = (t, ts, toolCalls) => ({ id: `a-${++seq}`, role: 'assistant', content: t, timestamp: ts, toolCalls });
const t0 = Date.now() - 600_000;

const cases = {
  repeated: [user('write report five times', t0), asst('done', t0 + 1000, [
    call('Write', `${WORK}/report.html`), call('Edit', `${WORK}/report.html`), call('Edit', `${WORK}/report.html`),
    call('Write', `${WORK}/report.html`), call('Edit', `${WORK}/report.html`)])],
  samebase: [user('two index files', t0), asst('done', t0 + 1000, [
    call('Write', `${WORK}/a/index.html`), call('Write', `${WORK}/b/index.html`)])],
  twoturns: [user('turn one', t0), asst('one', t0 + 1000, [call('Write', `${WORK}/report.html`)]),
    user('turn two', t0 + 2000), asst('two', t0 + 3000, [call('Edit', `${WORK}/report.html`)])],
  relabs: [user('rel + abs', t0), asst('done', t0 + 1000, [
    call('Write', './report.html'), call('Write', `${WORK}/report.html`)])],
};

async function dismiss(page) {
  const trust = page.getByRole('dialog', { name: '这个文件夹带了自动化配置，要启用吗？' });
  await trust.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
  if (await trust.isVisible().catch(() => false)) await trust.getByRole('button', { name: '先不启用' }).click();
  const ob = page.getByRole('dialog', { name: '初始化 Neo' });
  await ob.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  if (await ob.isVisible().catch(() => false)) await ob.getByRole('button', { name: '跳过，稍后在设置里配置' }).click();
  await page.waitForTimeout(500);
}
const EXPECTED = { repeated: 1, samebase: 2 };
let failed = false;
const results = {};
try {
  await waitUp();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(base + '/');
  await page.waitForSelector('.h-screen', { timeout: 20000 });
  const token = await page.evaluate(() => window.__CODE_AGENT_TOKEN__);
  const api = (p) => `${base}${p}${p.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  const ids = {};
  for (const [name, messages] of Object.entries(cases)) {
    const c = await (await fetch(api('/api/sessions'), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: `dedup-${name}`, workingDirectory: WORK }) })).json();
    ids[name] = c.data.id;
    const s = await fetch(api('/api/dev/seed-messages'), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: ids[name], messages }) });
    if (!s.ok) throw new Error(`seed ${name}: ${s.status} ${await s.text()}`);
  }
  for (const name of Object.keys(cases)) {
    await page.goto(base + '/');
    await page.waitForSelector('.h-screen');
    await dismiss(page);
    const row = page.locator(`[data-session-id="${ids[name]}"]`).first();
    await row.waitFor({ timeout: 15000 });
    await row.click();
    await dismiss(page);
    await page.waitForSelector('[data-trace-node-type="user"]', { timeout: 15000 });
    await page.waitForTimeout(1500);
    const info = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[role="button"][aria-label]')]
        .filter((el) => /\.html$/.test((el.getAttribute('aria-label') || '').split(': ').pop()));
      const scroller = (el) => { let n = el?.parentElement; while (n) { const o = getComputedStyle(n).overflowY; if (o === 'auto' || o === 'scroll') return n; n = n.parentElement; } return null; };
      const colEl = scroller(cards[0]);
      const col = colEl?.getBoundingClientRect();
      return { labels: cards.map((c) => c.getAttribute('aria-label')),
        rects: cards.map((c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }),
        col: col ? { x: col.x, y: col.y, w: col.width, h: col.height } : null };
    });
    const ov = [];
    info.rects.forEach((a, i) => info.rects.forEach((b, j) => { if (j > i && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) ov.push([i, j]); }));
    const clipped = info.col ? info.rects.filter((r) => r.x < info.col.x - 1 || r.x + r.w > info.col.x + info.col.w + 1).length : 'n/a(no column)';
    const shot = path.join(outDir, `${name}.png`);
    await page.screenshot({ path: shot });
    results[name] = { cardCount: info.labels.length, labels: info.labels, overlaps: ov.length, clipped, geometry: ov.length === 0 && clipped === 0 ? 'no overlaps' : 'PROBLEM', shot };
    console.log(name, JSON.stringify(results[name]));
    if (name in EXPECTED && info.labels.length !== EXPECTED[name]) {
      failed = true;
      console.log(`FAIL AssertionError: ${name} expected cardCount ${EXPECTED[name]} got ${info.labels.length}`);
    }
  }
  await browser.close();
} finally {
  stop();
}
if (failed) process.exit(1);
console.log('PASS: repeated=1 card, samebase=2 cards');
