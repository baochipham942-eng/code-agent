// T4 一致性锁定再编辑核心测试：验收「只改这块其余不变」。
// 纯像素函数用手搓 RawImage 覆盖（不依赖 sharp）；runRegionLockGate 用真 sharp 端到端编解码。
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import {
  diffOutsideMask,
  compositeRegionLock,
  buildDiffOverlay,
  runRegionLockGate,
  ensureRegionLockEnforceable,
  onRegionLockGateError,
  REGION_LOCK_STRICT_SHARP_UNAVAILABLE,
  REGION_LOCK_STRICT_GATE_FAILED,
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

  // H2：clean 快路径必须输出真 PNG，即使模型返回的是 JPEG 字节（防把 JPEG 写成 .png）。
  it('clean 路径输出始终是合法 PNG（模型返回 JPEG 也重编码）', async () => {
    const w = 16, h = 16;
    const original = makeRaw(w, h, () => [120, 120, 120]);
    // 用 JPEG 编码"守规矩"的输出（jpeg 有损，留区可能微漂但应在 ε 内；放大 ε 排除有损噪声干扰）。
    const editedJpeg = await sharp(Buffer.from(original.data), {
      raw: { width: w, height: h, channels: 4 },
    }).jpeg({ quality: 100 }).toBuffer();
    const mask = makeRaw(w, h, () => [255, 255, 255]); // 全编辑区，留区为空必 clean
    const { finalPng, report } = await runRegionLockGate({
      originalBuf: await pngFrom(original),
      editedBuf: editedJpeg,
      maskBuf: await pngFrom(mask),
      epsilon: EPS,
      sharp,
    });
    expect(report.status).toBe('clean');
    const meta = await sharp(finalPng).metadata();
    expect(meta.format).toBe('png'); // 不能是 jpeg
  });

  // H1 守卫 + M5：池化尺寸的极小图（1x1 / 2x2，落 Node Buffer 内存池）跨多次解码无别名串扰。
  it('1x1 图（最小边界）clean 路径正确', async () => {
    const original = makeRaw(1, 1, () => [50, 60, 70]);
    const edited = makeRaw(1, 1, () => [200, 10, 10]);
    const mask = makeRaw(1, 1, () => [255, 255, 255]); // 编辑区
    const { report } = await runRegionLockGate({
      originalBuf: await pngFrom(original), editedBuf: await pngFrom(edited),
      maskBuf: await pngFrom(mask), epsilon: EPS, sharp,
    });
    expect(report.passed).toBe(true);
    expect(report.keepPixels).toBe(0);
  });

  it('2x2 池化小图 locked 路径：留区逐像素回原图（多解码无别名串扰）', async () => {
    // 左列编辑(白)，右列留(黑)。模型把右列也漂了。
    const original = makeRaw(2, 2, () => [100, 110, 120]);
    const edited = makeRaw(2, 2, (x) => (x === 0 ? [220, 30, 30] : [40, 40, 40]));
    const mask = makeRaw(2, 2, (x) => (x === 0 ? [255, 255, 255] : [0, 0, 0]));
    const { finalPng, report } = await runRegionLockGate({
      originalBuf: await pngFrom(original), editedBuf: await pngFrom(edited),
      maskBuf: await pngFrom(mask), epsilon: EPS, sharp,
    });
    expect(report.status).toBe('locked');
    const dec = await decodeRGB(finalPng);
    // 右列(x=1)两像素必须 == 原图 [100,110,120]
    for (const y of [0, 1]) {
      const i = (y * 2 + 1) * 4;
      expect([dec.data[i], dec.data[i + 1], dec.data[i + 2]]).toEqual([100, 110, 120]);
    }
  });

  // M5：mask 全黑（整图皆留区）+ 模型整图漂移 → locked 且 composite 还原整张原图。
  it('mask 全黑（无编辑区）+ 模型漂移 → locked 还原整张原图', async () => {
    const w = 8, h = 8;
    const original = makeRaw(w, h, () => [70, 80, 90]);
    const edited = makeRaw(w, h, () => [170, 180, 190]);
    const mask = makeRaw(w, h, () => [0, 0, 0]); // 全留区
    const { finalPng, report } = await runRegionLockGate({
      originalBuf: await pngFrom(original), editedBuf: await pngFrom(edited),
      maskBuf: await pngFrom(mask), epsilon: EPS, sharp,
    });
    expect(report.status).toBe('locked');
    expect(report.keepPixels).toBe(w * h);
    const dec = await decodeRGB(finalPng);
    const i = (4 * w + 4) * 4;
    expect([dec.data[i], dec.data[i + 1], dec.data[i + 2]]).toEqual([70, 80, 90]);
  });
});

// ---- 严格模式守卫（可选硬保证）----
describe('ensureRegionLockEnforceable', () => {
  it('sharp 可用：无论是否严格都返回 true（继续跑闸）', () => {
    expect(ensureRegionLockEnforceable({ strict: false, sharpAvailable: true })).toBe(true);
    expect(ensureRegionLockEnforceable({ strict: true, sharpAvailable: true })).toBe(true);
  });

  it('sharp 不可用 + 非严格：返回 false（best-effort 降级，不抛错）', () => {
    expect(ensureRegionLockEnforceable({ strict: false, sharpAvailable: false })).toBe(false);
  });

  it('sharp 不可用 + 严格：抛错（拒绝产出未保证产物，付费前拦截）', () => {
    expect(() => ensureRegionLockEnforceable({ strict: true, sharpAvailable: false })).toThrow(
      REGION_LOCK_STRICT_SHARP_UNAVAILABLE,
    );
  });
});

describe('onRegionLockGateError', () => {
  it('非严格：静默返回（调用方降级写模型原图）', () => {
    expect(() => onRegionLockGateError({ strict: false, cause: new Error('decode boom') })).not.toThrow();
  });

  it('严格：抛错且链上 cause', () => {
    const cause = new Error('decode boom');
    try {
      onRegionLockGateError({ strict: true, cause });
      throw new Error('应当已抛出');
    } catch (e) {
      expect((e as Error).message).toBe(REGION_LOCK_STRICT_GATE_FAILED);
      expect((e as Error & { cause?: unknown }).cause).toBe(cause);
    }
  });
});
