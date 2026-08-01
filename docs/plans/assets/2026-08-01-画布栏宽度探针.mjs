// 2026-08-01 画布栏遮挡探针（工单验收版）：侧栏态四档宽度 + 专注态，
// 对画布栏顶部条每个可点元素做 elementFromPoint 命中测试。
// 用法：先起服务（必须禁 renderer 热更新，指纹须与本地构建一致）：
//   CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE=1 CODE_AGENT_RENDERER_HOT_UPDATE=false \
//     WEB_HOST=127.0.0.1 WEB_PORT=<port> node dist/web/webServer.cjs
// 然后：node docs/plans/assets/2026-08-01-画布栏宽度探针.mjs <port>
// 种图走 paste 事件本地导入，不调付费 API。已知假阳性：引导文字 pointer-events:none，
// 命中测试必然返回它下面的 canvas——那不算遮挡，判它要用截图看（本探针不判引导文字）。
import { chromium } from 'playwright';
import { deflateSync } from 'node:zlib';
import { readdirSync, readFileSync } from 'node:fs';

const PORT = process.argv[2] || '8321';
const BASE = `http://127.0.0.1:${PORT}`;

// ---- 最小 PNG 编码器（纯色图，本地造种图，零 API）----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function solidPng(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8bit RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- 命中测试（页面内）：画布栏顶部条每个可点元素 ----
function hitTestInPage() {
  const targets = [];
  const bar = document.querySelector('[data-testid="design-image-toolbar"], [data-testid="diagram-toolbar"]');
  if (bar) targets.push(...bar.querySelectorAll('button, [role="button"]'));
  for (const id of [
    'design-canvas-export-pptx',
    'rail-tab-shell-focus-toggle',
    'design-canvas-layers-toggle',
    'design-canvas-history-toggle',
  ]) {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (el) targets.push(el);
  }
  targets.push(...document.querySelectorAll('[data-testid="workbench-view-selector"] [role="tab"]'));
  const seen = new Set();
  const rows = [];
  for (const el of targets) {
    if (seen.has(el)) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    const name =
      el.getAttribute('data-testid') || el.getAttribute('aria-label') || el.textContent.trim().slice(0, 16);
    if (r.width === 0 || r.height === 0) {
      rows.push({ 元素: name, 结果: '跳过（零尺寸，不可点）' });
      continue;
    }
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    const ok = top === el || el.contains(top) || (top && top.contains(el));
    rows.push({
      元素: name,
      结果: ok ? '可达' : `被遮挡 ← ${top?.getAttribute?.('data-testid') || `${top?.tagName}.${String(top?.className).slice(0, 50)}`}`,
    });
  }
  const rail = document.querySelector('[data-testid="workbench-view-selector"]');
  return {
    栏宽: rail ? Math.round(rail.getBoundingClientRect().width) : null,
    窗口宽: window.innerWidth,
    顶条: bar ? (bar.getAttribute('data-testid')) : '未找到',
    rows,
  };
}

const b = await chromium.launch({ headless: true });
const b64 = solidPng(640, 360, [88, 130, 200]).toString('base64');

async function boot() {
  const p = await b.newPage({ viewport: { width: 2000, height: 1000 } });
  await p.goto(BASE, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(5000);
  // 指纹核对：服务给的 renderer bundle 必须就是本地 dist/renderer 新鲜构建
  const local = readdirSync('dist/renderer/assets').filter((f) => f.startsWith('index-'));
  const html = await p.content();
  const served = local.filter((f) => html.includes(f));
  console.log(JSON.stringify({ 指纹: { 本地构建: local, 页面引用一致: served.length === local.length } }));
  // 打开设计画布（空态 launcher 直点；否则 Meta+K 命令面板）
  const direct = p.locator('[data-testid="open-workbench-view-design-canvas"]');
  if (await direct.count()) {
    await direct.first().click();
  } else {
    await p.keyboard.press('Meta+k');
    await p.waitForTimeout(1000);
    await p.getByText('设计画布', { exact: false }).first().click();
  }
  await p.waitForTimeout(3000);
  // 等画布 tab 真挂上再种图（paste 监听在 DesignCanvas mount 的 effect 里，抢跑会丢图）
  await p.waitForSelector('[data-testid="design-canvas-tab"]', { timeout: 15000 });
  // paste 事件走本地导入种图（不调付费 API）；等种子落地（导出按钮出现），没落地补种一次
  const seedOnce = () =>
    p.evaluate(async (b64) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([arr], 's.png', { type: 'image/png' }));
      window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, b64);
  await seedOnce();
  try {
    await p.waitForSelector('[data-testid="design-canvas-export-pptx"]', { timeout: 10000 });
  } catch {
    await seedOnce();
    await p.waitForSelector('[data-testid="design-canvas-export-pptx"]', { timeout: 10000 });
  }
  return p;
}

async function setRailWidth(p, targetPx) {
  const handle = p.locator('.cursor-col-resize').first();
  const hb = await handle.boundingBox();
  const rail = await p.locator('[data-testid="workbench-view-selector"]').boundingBox();
  if (!hb || !rail) return null;
  const delta = rail.width - targetPx; // 往左拖 = 右栏变宽
  await p.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await p.mouse.down();
  await p.mouse.move(hb.x + hb.width / 2 + delta, hb.y + hb.height / 2, { steps: 10 });
  await p.mouse.up();
  await p.waitForTimeout(500);
  const after = await p.locator('[data-testid="workbench-view-selector"]').boundingBox();
  return Math.round(after?.width ?? -1);
}

const page = await boot();

// —— 侧栏态四档宽度：22% / 26% / 31% / 35%（允许拖动的全量程）——
const groupW = 2000 - (await page.locator('div.w-60').count()) * 240;
for (const pct of [22, 26, 31, 35]) {
  const target = Math.round((groupW * pct) / 100);
  const actual = await setRailWidth(page, target);
  const r = await page.evaluate(hitTestInPage);
  console.log(JSON.stringify({ 场景: `侧栏态 ${pct}%（目标 ${target}px，实测 ${actual}px）`, ...r }));
}

// —— 专注态：聊天列收起，画布栏占满窗口 ——
await page.locator('[data-testid="rail-tab-shell-focus-toggle"]').click();
await page.waitForTimeout(800);
const focusRail = await page.locator('[data-testid="workbench-view-selector"]').boundingBox();
const focusHit = await page.evaluate(hitTestInPage);
console.log(JSON.stringify({
  场景: `专注态（栏宽 ${Math.round(focusRail?.width ?? -1)}px / 窗口 2000px，聊天列应已收起）`,
  ...focusHit,
}));

// Esc 退出专注态 → 聊天列应回来（栏宽回落到 35% 以下）
await page.keyboard.press('Escape');
await page.waitForTimeout(800);
const afterEsc = await page.evaluate(() => {
  const w = Math.round(document.querySelector('[data-testid="workbench-view-selector"]')?.getBoundingClientRect().width ?? -1);
  return { 退出后栏宽: w, 聊天列回来: w > 0 && w < window.innerWidth * 0.35 };
});
console.log(JSON.stringify({ 场景: 'Esc 退出专注态', ...afterEsc }));

await b.close();
