// 2026-08-01 空态与边栏归一工单：真机截图取证。
// 五张：空态（新引导卡）/ 有图未选中（画布级工具条含导出 PPTX）/ 有图选中（图级动词条）/
//       边栏归一面板·图层 tab / 边栏归一面板·历史 tab。
// 用法：先起服务（禁 renderer 热更新，指纹与本地构建一致），再
//   node docs/plans/assets/2026-08-01-画布-空态与边栏归一截图.mjs <port> <输出目录>
// 种图走 paste 事件本地导入，不调付费 API。
import { chromium } from 'playwright';
import { deflateSync } from 'node:zlib';
import { mkdirSync } from 'node:fs';

const PORT = process.argv[2] || '8360';
const OUT = process.argv[3] || '/tmp/canvas-shots';
const BASE = `http://127.0.0.1:${PORT}`;
mkdirSync(OUT, { recursive: true });

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
  ihdr[8] = 8; ihdr[9] = 2;
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

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 950 } });
await p.goto(BASE, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(5000);
const direct = p.locator('[data-testid="open-workbench-view-design-canvas"]');
if (await direct.count()) {
  await direct.first().click();
} else {
  await p.keyboard.press('Meta+k');
  await p.waitForTimeout(1000);
  await p.getByText('设计画布', { exact: false }).first().click();
}
await p.waitForSelector('[data-testid="design-canvas-tab"]', { timeout: 15000 });
await p.waitForTimeout(2000);
const shot = (name) => p.screenshot({ path: `${OUT}/${name}.png` });

// 1. 空态：新引导卡（两条主线入口 + 绘图入口），工具条不铺开
await p.waitForSelector('[data-testid="design-canvas-empty-guide"]', { timeout: 10000 });
await shot('01-空态');

// 2. 种图 → 有图未选中：画布级工具条（含导出 PPTX）
const b64 = solidPng(640, 360, [88, 130, 200]).toString('base64');
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
await p.waitForTimeout(1500);
await shot('02-有图未选中');

// 3. 有图选中：点画布中央节点 → 图级动词条（PPTX 在「更多 · 整个画布」组）
const canvasBox = await p.locator('[data-testid="design-canvas"]').boundingBox();
await p.mouse.click(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
await p.waitForSelector('[data-testid="design-image-toolbar"]', { timeout: 5000 });
await p.waitForTimeout(500);
await shot('03-有图选中');

// 4. 边栏归一面板·图层 tab（先点空白取消选中，再开面板）
await p.mouse.click(canvasBox.x + 40, canvasBox.y + canvasBox.height - 40);
await p.waitForTimeout(500);
await p.getByTestId('design-canvas-sidepanel-toggle').click();
await p.waitForSelector('[data-testid="design-canvas-sidepanel"]', { timeout: 5000 });
await p.getByTestId('design-canvas-sidepanel-tab-layers').click();
await p.waitForTimeout(500);
await shot('04-面板-图层tab');

// 5. 边栏归一面板·历史 tab
await p.getByTestId('design-canvas-sidepanel-tab-history').click();
await p.waitForTimeout(500);
await shot('05-面板-历史tab');

await b.close();
console.log(`5 张截图已存 ${OUT}`);
