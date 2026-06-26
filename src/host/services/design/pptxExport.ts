// ============================================================================
// 设计模式 PPTX 导出（CD-Parity §4 薄版）—— 独立服务模块，不堆进 workspace.ipc.ts
// ----------------------------------------------------------------------------
// imagesToPptx —— N 张图 → 1 份 PPTX，每张 = 1 张全幅 slide（x:0,y:0,w:100%,h:100%）。
//   抽自 frontend-slides skill 的 merge-to-pptx-hybrid.mjs「图→全幅 slide」核心
//   （pptxgenjs 是生产依赖；主进程不 spawn 技能层 .mjs，尊重工程层/技能层分层）。
//   pptxgenjs 是 CJS——走 require 取构造器（与 pptGenerate getPptxGenJS 同款），
//   ESM 默认 import 在 Electron/esbuild 运行时会得到非构造器（dogfood 实锤 not a constructor）。
//   薄版：只铺全幅图，不做文字层智能叠加、不做半透明遮罩、不做自动布局。
//
// 版面/缩放决策：
//   - 版面用固定 LAYOUT_WIDE（13.33×7.5 英寸，16:9）——干系人 deck 默认 16:9，
//     不按首图宽高反推画布（设计画布的产物宽高各异，按某一张定全 deck 会让其余图变形）。
//   - sizing.type 用 'contain' 而非 'cover'：contain 完整保留每张图（按比例缩放进 slide，
//     不裁切、不拉伸），异比例图落进 16:9 时是「letterbox 留边」而非裁掉内容。设计稿
//     打包给干系人审阅，「完整可见」比「铺满无边」更重要，故选 contain。
// ============================================================================

import type PptxGenJSType from 'pptxgenjs';

type PptxGenJSConstructor = new () => PptxGenJSType;

// pptxgenjs 是 CJS，走 require 取构造器以保 Electron/esbuild 运行时兼容（与 pptGenerate 同款）。
function getPptxGenJS(): PptxGenJSConstructor {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const moduleValue: unknown = require('pptxgenjs');
  return moduleValue as PptxGenJSConstructor;
}

// 图字节 → data URI 的 MIME 嗅探（与 merge-to-pptx-hybrid 同款 magic-byte 检测，
// 不引第三方，PNG/JPEG 两类覆盖设计产物全部来源；未知一律按 PNG 兜底）。
function detectImageMime(buffer: Buffer): string {
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  return 'image/png';
}

/**
 * N 张图 → 1 份全幅 PPTX（每图一张 16:9 全幅 slide，contain 缩放不裁切/不变形）。
 * 空数组抛可读错误（无产物可打包）。返回 PPTX 的 nodebuffer。
 */
export async function imagesToPptx(images: Buffer[]): Promise<Buffer> {
  if (!Array.isArray(images) || images.length === 0) {
    throw new Error('PPTX 导出需要至少一张图片');
  }

  const PptxGenJS = getPptxGenJS();
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'Agent Neo Design';
  pptx.subject = '设计产物打包';

  for (const image of images) {
    if (!Buffer.isBuffer(image) || image.length === 0) {
      throw new Error('PPTX 导出收到空图片字节');
    }
    const mime = detectImageMime(image);
    const slide = pptx.addSlide();
    slide.addImage({
      data: `data:${mime};base64,${image.toString('base64')}`,
      x: 0,
      y: 0,
      w: '100%',
      h: '100%',
      sizing: { type: 'contain', w: '100%', h: '100%' },
    });
  }

  const out = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.from(out as Uint8Array);
}
