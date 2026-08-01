// 2026-08-01 画布栏遮挡探针（工单验收版）：侧栏态四档宽度 + 专注态，两种检测口径并列：
//   ① elementFromPoint 命中测试——画布栏顶部条每个可点元素实际可达；
//   ② 矩形相交检测——顶部区域内文本元素 × 可点元素两两 bounding box 相交判定，相交即失败。
// ② 存在的理由：命中测试对 pointer-events:none 的纯文本天生失明（返回的永远是文本底下的
// 元素），文本被压住半句时 ① 照样全绿——引导文字被「导出 PPTX」矩形相交就是这么漏过去的。
// 用法：先起服务（必须禁 renderer 热更新，指纹须与本地构建一致）：
//   CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE=1 CODE_AGENT_RENDERER_HOT_UPDATE=false \
//     WEB_HOST=127.0.0.1 WEB_PORT=<port> node dist/web/webServer.cjs
// 然后：node docs/plans/assets/2026-08-01-画布栏宽度探针.mjs <port>
// 种图走 paste 事件本地导入，不调付费 API。任一检测失败 → 进程退出码 1。
import { chromium } from 'playwright';
import { deflateSync } from 'node:zlib';
import { readdirSync } from 'node:fs';
import { findTextClickableCollisions } from '../../../scripts/acceptance/fixtures/design-topbar-occlusion.ts';

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

// ---- 页面内巡检（必须自包含：page.evaluate 只序列化本函数，引不到 Node 侧帮手）----
// 一次 evaluate 同时产出两种检测的原料：
//   ① 命中测试行：顶部条每个可点元素 elementFromPoint 实际可达性；
//   ② 相交检测原料：顶部区域文本 rect + 可点元素 rect（判定在 Node 侧走受测模块）。
// 顶部区域 = 画布容器顶 → max(顶条底缘, 导出按钮底缘) + 16px 余量。
// 文本元素 = 画布容器内叶子元素（无子元素）且自有文本非空；按钮自家 label（被可点元素包含）剔除。
function inspectTopBarInPage() {
  const nameOf = (el) =>
    el.getAttribute('data-testid') || el.getAttribute('aria-label') || el.textContent.trim().slice(0, 16);
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
  const clickables = targets.filter((el) => (seen.has(el) ? false : (seen.add(el), true)));

  // ① 命中测试
  const hitRows = [];
  for (const el of clickables) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) {
      hitRows.push({ 元素: nameOf(el), 结果: '跳过（零尺寸，不可点）' });
      continue;
    }
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    const ok = top === el || el.contains(top) || (top && top.contains(el));
    hitRows.push({
      元素: nameOf(el),
      结果: ok ? '可达' : `被遮挡 ← ${top?.getAttribute?.('data-testid') || `${top?.tagName}.${String(top?.className).slice(0, 50)}`}`,
    });
  }

  // ② 顶部区域文本收集
  const container = document.querySelector('[data-testid="design-canvas"]');
  const texts = [];
  if (container) {
    const cr = container.getBoundingClientRect();
    let regionBottom = cr.top + 120;
    for (const el of [bar, document.querySelector('[data-testid="design-canvas-export-pptx"]')]) {
      if (el) regionBottom = Math.max(regionBottom, el.getBoundingClientRect().bottom + 16);
    }
    for (const el of container.querySelectorAll('*')) {
      if (el.children.length > 0) continue; // 只看叶子，label 归并到宿主
      const text = el.textContent?.trim();
      if (!text) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.top >= regionBottom || r.bottom <= cr.top) continue; // 不在顶部区域
      if (clickables.some((c) => c.contains(el))) continue; // 按钮自家 label 不算受害者
      texts.push({ name: text.slice(0, 24), rect: { x: r.x, y: r.y, width: r.width, height: r.height } });
    }
  }

  const rail = document.querySelector('[data-testid="workbench-view-selector"]');
  return {
    栏宽: rail ? Math.round(rail.getBoundingClientRect().width) : null,
    窗口宽: window.innerWidth,
    顶条: bar ? bar.getAttribute('data-testid') : '未找到',
    hitRows,
    texts,
    clickables: clickables.map((el) => {
      const r = el.getBoundingClientRect();
      return { name: nameOf(el), rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
    }),
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

// 两种检测并列跑一遍；任一失败计入 failures（命中测试「被遮挡」/ 相交检测有碰撞）。
let failures = 0;
async function runChecks(p, 场景) {
  const { hitRows, texts, clickables, ...meta } = await p.evaluate(inspectTopBarInPage);
  const blocked = hitRows.filter((r) => r.结果.startsWith('被遮挡'));
  const collisions = findTextClickableCollisions(texts, clickables);
  failures += blocked.length + collisions.length;
  console.log(JSON.stringify({
    场景,
    ...meta,
    rows: hitRows,
    命中测试: blocked.length === 0 ? '全可达' : `${blocked.length} 个被遮挡`,
    相交检测: collisions.length === 0
      ? `无碰撞（文本 ${texts.length} × 可点 ${clickables.length}）`
      : collisions,
  }));
}

const page = await boot();

// —— 侧栏态四档宽度：22% / 26% / 31% / 35%（允许拖动的全量程）——
const groupW = 2000 - (await page.locator('div.w-60').count()) * 240;
for (const pct of [22, 26, 31, 35]) {
  const target = Math.round((groupW * pct) / 100);
  const actual = await setRailWidth(page, target);
  await runChecks(page, `侧栏态 ${pct}%（目标 ${target}px，实测 ${actual}px）`);
}

// —— 专注态：聊天列收起，画布栏占满窗口 ——
await page.locator('[data-testid="rail-tab-shell-focus-toggle"]').click();
await page.waitForTimeout(800);
const focusRail = await page.locator('[data-testid="workbench-view-selector"]').boundingBox();
await runChecks(page, `专注态（栏宽 ${Math.round(focusRail?.width ?? -1)}px / 窗口 2000px，聊天列应已收起）`);

// Esc 退出专注态 → 聊天列应回来（栏宽回落到 35% 以下）
await page.keyboard.press('Escape');
await page.waitForTimeout(800);
const afterEsc = await page.evaluate(() => {
  const w = Math.round(document.querySelector('[data-testid="workbench-view-selector"]')?.getBoundingClientRect().width ?? -1);
  return { 退出后栏宽: w, 聊天列回来: w > 0 && w < window.innerWidth * 0.35 };
});
console.log(JSON.stringify({ 场景: 'Esc 退出专注态', ...afterEsc }));

await b.close();
console.log(JSON.stringify({ 总结: failures === 0 ? '两种检测全过' : `${failures} 处失败` }));
if (failures > 0) process.exit(1);
