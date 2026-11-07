/* global fetch, setTimeout, window, document, getComputedStyle, console */
// Manual verify: seeded sessions -> deliverable card count + geometry on a real web build (headless only).
// Usage: node tests/manual/deliverable-dedup-verify.mjs <outDir>   (spawns dist/web/webServer.cjs itself)
// 纯逻辑（seed fixtures / 几何 / 判定）以命名导出供 tests/manual/deliverable-dedup-verify.test.ts
// 做 hermetic 覆盖；import 本文件不会起服务/开浏览器（底部 main-guard 守住）。
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

// 任务书的两个硬断言：同文件连写 5 次 → 1 张卡；同名不同目录 → 2 张卡。
// FU1 追加：单轮里 ./report.html 与同一文件的绝对路径 → 1 张卡（键对齐工作目录）。
// FU2 追加（owner 决策，11-06）：每轮一张卡、不做跨轮合并——卡片随聊天时间线出现，
// 轮内去重已防刷屏，合并会让早先轮次的产物消失；twoturns 断言每轮各出一张卡（共 2 张）。
export const EXPECTED_CARDS = { repeated: 1, samebase: 2, relabs: 1, twoturns: 2 };

// seed fixtures：与 src/renderer/utils/artifactOwnership.ts 消费的真实 Message/toolCalls 形状一致。
export function buildSeedCases(work, t0 = Date.now() - 600_000) {
  let seq = 0;
  const call = (name, file, extra = {}) => {
    const id = `tc-${++seq}`;
    return { id, name, arguments: { file_path: file, ...extra },
      result: { toolCallId: id, success: true, output: `${name} ok`, outputPath: file } };
  };
  const user = (t, ts) => ({ id: `u-${++seq}`, role: 'user', content: t, timestamp: ts });
  const asst = (t, ts, toolCalls) => ({ id: `a-${++seq}`, role: 'assistant', content: t, timestamp: ts, toolCalls });
  return {
    repeated: [user('write report five times', t0), asst('done', t0 + 1000, [
      call('Write', `${work}/report.html`), call('Edit', `${work}/report.html`), call('Edit', `${work}/report.html`),
      call('Write', `${work}/report.html`), call('Edit', `${work}/report.html`)])],
    samebase: [user('two index files', t0), asst('done', t0 + 1000, [
      call('Write', `${work}/a/index.html`), call('Write', `${work}/b/index.html`)])],
    twoturns: [user('turn one', t0), asst('one', t0 + 1000, [call('Write', `${work}/report.html`)]),
      user('turn two', t0 + 2000), asst('two', t0 + 3000, [call('Edit', `${work}/report.html`)])],
    relabs: [user('rel + abs', t0), asst('done', t0 + 1000, [
      call('Write', './report.html'), call('Write', `${work}/report.html`)])],
  };
}

// 成对矩形相交（j>i，每对只报一次）——「no overlaps」几何断言的承重逻辑。
export function findOverlaps(rects) {
  const ov = [];
  rects.forEach((a, i) => rects.forEach((b, j) => {
    if (j > i && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) ov.push([i, j]);
  }));
  return ov;
}

// 水平方向被聊天滚动列裁掉的卡片数；找不到列时返回哨兵字符串（记 n/a，不当 0）。
export function countClipped(rects, col) {
  return col ? rects.filter((r) => r.x < col.x - 1 || r.x + r.w > col.x + col.w + 1).length : 'n/a(no column)';
}

// 单 case 判定：卡片数、几何结论、以及（仅 EXPECTED_CARDS 里登记的 case）断言失败文案。
// 脚本按 failures 非空退出非零（repeated=1 / samebase=2 是门）。
export function evaluateCase(name, info, shot) {
  const overlaps = findOverlaps(info.rects);
  const clipped = countClipped(info.rects, info.col);
  const cardCount = info.labels.length;
  const expected = EXPECTED_CARDS[name];
  return {
    cardCount,
    labels: info.labels,
    overlaps: overlaps.length,
    clipped,
    geometry: overlaps.length === 0 && clipped === 0 ? 'no overlaps' : 'PROBLEM',
    shot,
    failures: expected !== undefined && cardCount !== expected
      ? [`FAIL AssertionError: ${name} expected cardCount ${expected} got ${cardCount}`]
      : [],
  };
}

async function waitUp(base) {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(base + '/'); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not start');
}

async function dismiss(page) {
  const trust = page.getByRole('dialog', { name: '这个文件夹带了自动化配置，要启用吗？' });
  await trust.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
  if (await trust.isVisible().catch(() => false)) await trust.getByRole('button', { name: '先不启用' }).click();
  const ob = page.getByRole('dialog', { name: '初始化 Neo' });
  await ob.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  if (await ob.isVisible().catch(() => false)) await ob.getByRole('button', { name: '跳过，稍后在设置里配置' }).click();
  await page.waitForTimeout(500);
}

async function main() {
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
  const WORK = '/Users/leo/work/dedup-demo';
  const cases = buildSeedCases(WORK);
  let failed = false;
  try {
    await waitUp(base);
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
      const shot = path.join(outDir, `${name}.png`);
      await page.screenshot({ path: shot });
      const res = evaluateCase(name, info, shot);
      console.log(name, JSON.stringify(res));
      for (const f of res.failures) { failed = true; console.log(f); }
    }
    await browser.close();
  } finally {
    stop();
  }
  if (failed) process.exit(1);
  console.log('PASS: repeated=1 card, samebase=2 cards, relabs=1 card, twoturns=2 cards (one card per turn)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
