// ============================================================================
// 设计模式 PDF 导出（CD-Parity §2）—— 独立服务模块，不堆进 workspace.ipc.ts
// ----------------------------------------------------------------------------
// 两条路：
//   htmlToPdf  —— HTML 原型走 Playwright chromium headless 的 page.pdf()，矢量级、
//                文字可选、体积小。复用 loadPlaywrightChromium 的可用性降级（不可用
//                时抛可读错误，绝不崩；调用方据此回退导出 .html）。
//   imageToPdf —— 栅格产物（画布/信息图/设计稿 PNG）走 pdfkit 单页图嵌：用 sharp 读
//                原图宽高 → 按图尺寸建页 → doc.image 全幅铺满 → 收集 chunks 成 Buffer。
//                纯 Node、零 chromium 依赖，Tauri/web 双通。
// ============================================================================

import PDFDocument from 'pdfkit';
import { loadPlaywrightChromium } from '../../runtime/playwrightRuntime';
import { loadSharp } from '../../runtime/sharpRuntime';

const PLAYWRIGHT_UNAVAILABLE_PREFIX = 'PDF 导出需要 Playwright Chromium';

/**
 * HTML 原型 → 矢量 PDF（Playwright chromium headless `page.pdf()`）。
 * chromium 不可用时抛可读错误，由调用方降级（仍可导 .html）。
 */
export async function htmlToPdf(html: string): Promise<Buffer> {
  const playwright = await loadPlaywrightChromium();
  if (!playwright.ok || !playwright.chromium) {
    throw new Error(
      `${PLAYWRIGHT_UNAVAILABLE_PREFIX}：${playwright.error ?? 'Playwright Chromium 不可用'}`,
    );
  }
  const { chromium } = playwright;
  let browser: import('playwright').Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    // 静态打印隔离（安全加固）：① 关 JS——打印不需要运行原型脚本，杜绝脚本 SSRF/exfil；
    // ② newContext 承载该开关后再开 page。
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    // ③ setContent 之前拦截所有请求：只放行 data:/about:（内联资源/页面本身），其余一律
    // abort——阻断外链子资源（图片/字体/CSS/信标）回连网络。打印导出可接受外链缺失。
    await page.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith('data:') || u.startsWith('about:')) {
        void route.continue();
      } else {
        void route.abort();
      }
    });
    // load 而非 networkidle：原型是 srcDoc 单文件，无外链长轮询，networkidle 可能因
    // 内联资源/字体轮询不收敛导致超时；load 足以等到 DOM + 样式就绪。
    await page.setContent(html, { waitUntil: 'load' });
    const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
    return Buffer.from(pdf);
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

/**
 * 栅格图（PNG/JPEG 等）→ 单页 PDF（pdfkit 图嵌）。
 * 页面尺寸 = 图像原始像素宽高，图全幅铺满（0,0 起、width/height 占满整页）。
 */
export async function imageToPdf(imageBuffer: Buffer): Promise<Buffer> {
  const loaded = loadSharp();
  if (!loaded.ok || !loaded.sharp) {
    throw new Error(loaded.error ?? 'Sharp image runtime is unavailable.');
  }
  // 先经 sharp 归一化成非交错 8-bit PNG，再喂 pdfkit：pdfkit 自带的 PNG 解码器较严格，
  // 对交错/非常规色彩类型/中转产出的畸形 PNG 会抛 "Incomplete or corrupt PNG file"。
  // 归一化一次即消除整类兼容问题（同一 sharp 调用顺带拿到尺寸，不增加额外解码）。
  const normalized = await loaded.sharp(imageBuffer).png().toBuffer({ resolveWithObject: true });
  const width = normalized.info.width;
  const height = normalized.info.height;
  if (!width || !height) {
    throw new Error('imageToPdf 无法读取图像尺寸');
  }
  const pngBuffer = normalized.data;

  return await new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: [width, height], margin: 0 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (error: Error) => reject(error));
      doc.image(pngBuffer, 0, 0, { width, height });
      doc.end();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
