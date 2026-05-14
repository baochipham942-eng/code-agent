import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import { prepareImageForVision } from '../../../../src/main/services/desktop/visionAnalysisService';
import { VISION_IMAGE } from '../../../../src/shared/constants';

// 真 sharp + 真临时文件，验证 Gap 1 的降采样 + 尺寸记账逻辑。
const createdFiles: string[] = [];

async function makePng(width: number, height: number): Promise<string> {
  const filePath = path.join(os.tmpdir(), `vision-prepare-test-${width}x${height}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  await sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 80, b: 200 } },
  }).png().toFile(filePath);
  createdFiles.push(filePath);
  return filePath;
}

afterEach(() => {
  while (createdFiles.length) {
    const f = createdFiles.pop();
    if (f) fs.promises.unlink(f).catch(() => undefined);
  }
});

describe('prepareImageForVision', () => {
  it('Retina 截图按 scaleFactor 降到逻辑点空间（未超 cap 不再额外缩）', async () => {
    // 2880x1800 物理像素，scaleFactor=2 → 逻辑 1440x900，未超 MAX_EDGE_PX
    const src = await makePng(2880, 1800);
    const { dims, tempPath } = await prepareImageForVision(src, 2);

    expect(dims.originalWidth).toBe(2880);
    expect(dims.originalHeight).toBe(1800);
    expect(dims.analyzedWidth).toBe(1440);
    expect(dims.analyzedHeight).toBe(900);
    expect(tempPath).not.toBeNull();
    if (tempPath) {
      expect(fs.existsSync(tempPath)).toBe(true);
      createdFiles.push(tempPath);
    }
  });

  it('逻辑尺寸仍超 MAX_EDGE_PX 时继续等比降采样，analyzed 从输出文件回读', async () => {
    // 4000x3000 物理，scaleFactor=2 → 逻辑 2000x1500，长边 2000 > 1568 → 再缩
    const src = await makePng(4000, 3000);
    const { dims, tempPath } = await prepareImageForVision(src, 2);

    expect(dims.originalWidth).toBe(4000);
    expect(dims.analyzedWidth).not.toBeNull();
    expect(Math.max(dims.analyzedWidth!, dims.analyzedHeight!)).toBeLessThanOrEqual(VISION_IMAGE.MAX_EDGE_PX);
    // 等比：1568 / 2000 * 1500 ≈ 1176
    expect(dims.analyzedWidth).toBe(1568);
    expect(dims.analyzedHeight).toBe(1176);
    if (tempPath) {
      // analyzed 必须等于实际输出文件尺寸，不是请求的目标值
      const outMeta = await sharp(tempPath).metadata();
      expect(outMeta.width).toBe(dims.analyzedWidth);
      expect(outMeta.height).toBe(dims.analyzedHeight);
      createdFiles.push(tempPath);
    }
  });

  it('非 Retina（scaleFactor=1）且未超 cap → 不 resize，原图直发', async () => {
    const src = await makePng(800, 600);
    const { dims, tempPath } = await prepareImageForVision(src, 1);

    expect(dims.originalWidth).toBe(800);
    expect(dims.analyzedWidth).toBe(800);
    expect(dims.analyzedHeight).toBe(600);
    expect(tempPath).toBeNull();
  });

  it('文件完全读不出来 → 抛错（交给调用方 catch）', async () => {
    await expect(
      prepareImageForVision('/nonexistent/path/does-not-exist.png', 2),
    ).rejects.toThrow();
  });
});
