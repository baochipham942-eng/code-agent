// ============================================================================
// pptxExport - 设计模式 PPTX 导出服务（CD-Parity §4 薄版）
// 覆盖：imagesToPptx 真 pptxgenjs 产物校验（PPTX = ZIP，魔数 'PK'）；空数组抛可读错误；
//       空图片字节抛错。每张图 → 1 张全幅 slide（薄版无文字层）。
// ============================================================================

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { imagesToPptx } from '../../../../src/host/services/design/pptxExport';

async function smallPng(color: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({
    create: { width: 8, height: 6, channels: 4, background: { ...color, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

describe('imagesToPptx', () => {
  it('packs 2 PNGs into a valid PPTX (ZIP magic PK, non-trivial size)', async () => {
    const a = await smallPng({ r: 255, g: 0, b: 0 });
    const b = await smallPng({ r: 0, g: 0, b: 255 });

    const pptx = await imagesToPptx([a, b]);

    expect(Buffer.isBuffer(pptx)).toBe(true);
    // PPTX 是 OOXML = ZIP 容器，前两字节为 'PK'（0x50 0x4b）。
    expect(pptx.subarray(0, 2).toString('latin1')).toBe('PK');
    // 两张全幅图嵌入 → 非平凡体积（远超空 zip 的几十字节）。
    expect(pptx.length).toBeGreaterThan(1000);
  });

  it('packs a single image as well', async () => {
    const pptx = await imagesToPptx([await smallPng({ r: 0, g: 255, b: 0 })]);
    expect(pptx.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('throws a readable error on empty array', async () => {
    await expect(imagesToPptx([])).rejects.toThrow(/至少一张图片/);
  });

  it('throws when an image buffer is empty', async () => {
    await expect(imagesToPptx([Buffer.alloc(0)])).rejects.toThrow(/空图片字节/);
  });
});
