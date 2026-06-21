// T4 一致性锁定再编辑核心测试：验收「只改这块其余不变」。
// 纯像素函数用手搓 RawImage 覆盖（不依赖 sharp）；runRegionLockGate 用真 sharp 端到端编解码。
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import {
  diffOutsideMask,
  compositeRegionLock,
  buildDiffOverlay,
  runRegionLockGate,
  type RawImage,
} from '../../../../../src/main/services/media/imageConsistency';
import { REGION_LOCK } from '../../../../../src/shared/constants/designWorkspace';

// ---- 手搓 RawImage 工具 ----
// fill(x,y) 返回 [r,g,b]（alpha 固定 255）。
function makeRaw(
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number],
): RawImage {
  const channels = 4;
  const data = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const [r, g, b] = fill(x, y);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { data, width, height, channels };
}

// mask：左半白(编辑区)，右半黑(留区)。
function leftHalfEditMask(w: number, h: number): RawImage {
  return makeRaw(w, h, (x) => (x < w / 2 ? [255, 255, 255] : [0, 0, 0]));
}

const EPS = REGION_LOCK.EPSILON;

describe('diffOutsideMask — 仅在 mask 留区(黑)逐像素比较', () => {
  it('未选区域完全相同（只改了选区）→ passed=true, maxDelta=0, changedPixels=0', () => {
    const w = 8, h = 8;
    const original = makeRaw(w, h, () => [100, 100, 100]);
    // 编辑区(左半)改成红色，留区(右半)保持 100
    const edited = makeRaw(w, h, (x) => (x < w / 2 ? [255, 0, 0] : [100, 100, 100]));
    const mask = leftHalfEditMask(w, h);
    const m = diffOutsideMask(original, edited, mask, EPS);
    expect(m.maxDelta).toBe(0);
    expect(m.changedPixels).toBe(0);
    expect(m.passed).toBe(true);
    expect(m.keepPixels).toBe((w / 2) * h); // 右半
  });

  it('未选区域被改且超过 ε → passed=false 且统计到越界像素', () => {
    const w = 8, h = 8;
    const original = makeRaw(w, h, () => [100, 100, 100]);
    // 留区(右半)被偷偷改成 150（差 50 > ε）
    const edited = makeRaw(w, h, (x) => (x < w / 2 ? [255, 0, 0] : [150, 100, 100]));
    const mask = leftHalfEditMask(w, h);
    const m = diffOutsideMask(original, edited, mask, EPS);
    expect(m.passed).toBe(false);
    expect(m.maxDelta).toBe(50);
    expect(m.changedPixels).toBe((w / 2) * h); // 整个右半越界
  });

  it('未选区域改动在 ε 内（如重压缩噪声）→ passed=true', () => {
    const w = 8, h = 8;
    const original = makeRaw(w, h, () => [100, 100, 100]);
    const drift = Math.max(0, EPS - 1);
    const edited = makeRaw(w, h, (x) => (x < w / 2 ? [255, 0, 0] : [100 + drift, 100, 100]));
    const mask = leftHalfEditMask(w, h);
    const m = diffOutsideMask(original, edited, mask, EPS);
    expect(m.maxDelta).toBe(drift);
    expect(m.passed).toBe(true);
    expect(m.changedPixels).toBe(0);
  });

  it('mask 全白（整图皆编辑区）→ keepPixels=0, passed=true（无可越界区）', () => {
    const w = 4, h = 4;
    const original = makeRaw(w, h, () => [10, 20, 30]);
    const edited = makeRaw(w, h, () => [200, 200, 200]);
    const mask = makeRaw(w, h, () => [255, 255, 255]);
    const m = diffOutsideMask(original, edited, mask, EPS);
    expect(m.keepPixels).toBe(0);
    expect(m.passed).toBe(true);
  });
});

describe('compositeRegionLock — 留区贴回原图，逐像素一致', () => {
  it('留区(黑)逐像素 == 原图，编辑区(白) == 模型输出', () => {
    const w = 8, h = 8;
    const original = makeRaw(w, h, () => [100, 100, 100]);
    // 模型整图都漂了：编辑区红、留区错误地变 150
    const edited = makeRaw(w, h, (x) => (x < w / 2 ? [255, 0, 0] : [150, 150, 150]));
    const mask = leftHalfEditMask(w, h);
    const out = compositeRegionLock(original, edited, mask);
    expect(out.channels).toBe(4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * out.channels;
        if (x < w / 2) {
          // 编辑区取模型输出
          expect([out.data[i], out.data[i + 1], out.data[i + 2]]).toEqual([255, 0, 0]);
        } else {
          // 留区逐像素回到原图 100（保证"其余不变"）
          expect([out.data[i], out.data[i + 1], out.data[i + 2]]).toEqual([100, 100, 100]);
        }
      }
    }
    // 合成后再过 gate：留区必然完全一致
    const m = diffOutsideMask(original, out, mask, EPS);
    expect(m.maxDelta).toBe(0);
    expect(m.passed).toBe(true);
  });
});

describe('buildDiffOverlay — 越界像素标红作证据', () => {
  it('留区越界处标红 (255,0,0)，输出 RGBA', () => {
    const w = 8, h = 8;
    const original = makeRaw(w, h, () => [100, 100, 100]);
    const edited = makeRaw(w, h, (x) => (x < w / 2 ? [255, 0, 0] : [200, 100, 100]));
    const mask = leftHalfEditMask(w, h);
    const overlay = buildDiffOverlay(original, edited, mask, EPS);
    expect(overlay.channels).toBe(4);
    // 右半某个留区像素应标红
    const px = (3 * w + 6) * overlay.channels; // x=6 在右半
    expect(overlay.data[px]).toBe(255);
    expect(overlay.data[px + 1]).toBe(0);
    expect(overlay.data[px + 2]).toBe(0);
  });
});

// ---- sharp 端到端 ----
async function pngFrom(raw: RawImage): Promise<Buffer> {
  return sharp(Buffer.from(raw.data), {
    raw: { width: raw.width, height: raw.height, channels: raw.channels as 3 | 4 },
  })
    .png()
    .toBuffer();
}

async function decodeRGB(png: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const img = sharp(png).ensureAlpha();
  const meta = await img.metadata();
  const data = await img.raw().toBuffer();
  return { data, width: meta.width ?? 0, height: meta.height ?? 0 };
}

describe('runRegionLockGate — sharp 端到端', () => {
  it('模型守住未选区 → status=clean，finalPng 即模型输出', async () => {
    const w = 16, h = 16;
    const original = makeRaw(w, h, () => [120, 120, 120]);
    const edited = makeRaw(w, h, (x) => (x < w / 2 ? [10, 200, 50] : [120, 120, 120]));
    const mask = leftHalfEditMask(w, h);
    const { finalPng, report, diffPng } = await runRegionLockGate({
      originalBuf: await pngFrom(original),
      editedBuf: await pngFrom(edited),
      maskBuf: await pngFrom(mask),
      epsilon: EPS,
      sharp,
    });
    expect(report.passed).toBe(true);
    expect(report.status).toBe('clean');
    expect(report.dimensionMatched).toBe(true);
    expect(diffPng).toBeNull();
    // finalPng 解码后编辑区是绿色
    const dec = await decodeRGB(finalPng);
    const i = (3 * w + 2) * 4;
    expect([dec.data[i], dec.data[i + 1], dec.data[i + 2]]).toEqual([10, 200, 50]);
  });

  it('模型越界改了未选区 → status=locked，finalPng 留区逐像素回原图，产出 diffPng', async () => {
    const w = 16, h = 16;
    const original = makeRaw(w, h, () => [120, 120, 120]);
    // 留区被改成 60（差 60 > ε）
    const edited = makeRaw(w, h, (x) => (x < w / 2 ? [10, 200, 50] : [60, 60, 60]));
    const mask = leftHalfEditMask(w, h);
    const { finalPng, report, diffPng } = await runRegionLockGate({
      originalBuf: await pngFrom(original),
      editedBuf: await pngFrom(edited),
      maskBuf: await pngFrom(mask),
      epsilon: EPS,
      sharp,
    });
    expect(report.passed).toBe(false);
    expect(report.status).toBe('locked');
    expect(report.maxDelta).toBeGreaterThanOrEqual(50);
    expect(diffPng).not.toBeNull();
    // finalPng 留区(右半)应被锁回 120
    const dec = await decodeRGB(finalPng);
    const keep = (3 * w + 12) * 4; // x=12 右半
    expect([dec.data[keep], dec.data[keep + 1], dec.data[keep + 2]]).toEqual([120, 120, 120]);
    // 编辑区仍是模型绿色
    const editPx = (3 * w + 2) * 4;
    expect([dec.data[editPx], dec.data[editPx + 1], dec.data[editPx + 2]]).toEqual([10, 200, 50]);
  });

  it('模型返回尺寸不一致 → 自动 resize 对齐，dimensionMatched=false 仍可合成', async () => {
    const w = 16, h = 16;
    const original = makeRaw(w, h, () => [120, 120, 120]);
    const editedSmall = makeRaw(w / 2, h / 2, (x) => (x < w / 4 ? [10, 200, 50] : [120, 120, 120]));
    const mask = leftHalfEditMask(w, h);
    const { finalPng, report } = await runRegionLockGate({
      originalBuf: await pngFrom(original),
      editedBuf: await pngFrom(editedSmall),
      maskBuf: await pngFrom(mask),
      epsilon: EPS,
      sharp,
    });
    expect(report.dimensionMatched).toBe(false);
    const dec = await decodeRGB(finalPng);
    expect(dec.width).toBe(w);
    expect(dec.height).toBe(h);
  });
});
