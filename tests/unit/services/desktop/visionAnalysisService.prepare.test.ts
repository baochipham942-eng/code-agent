import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import { prepareImageForVision } from '../../../../src/host/services/desktop/visionAnalysisService';
import { VISION_IMAGE } from '../../../../src/shared/constants';

// 真 sharp + 真临时文件，验证 Gap 1 的降采样 + 尺寸记账逻辑。
const createdFiles: string[] = [];

// 默认透传真 loadSharp；个别用例 mockReturnValue 覆盖成「sharp 不可用 / stub 抛错」。
const { loadSharpOverrideMock } = vi.hoisted(() => ({ loadSharpOverrideMock: vi.fn() }));

vi.mock('../../../../src/host/runtime/sharpRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/host/runtime/sharpRuntime')>();
  return {
    ...actual,
    loadSharp: (options?: Parameters<typeof actual.loadSharp>[0]) =>
      loadSharpOverrideMock(options) ?? actual.loadSharp(options),
  };
});

async function makePng(width: number, height: number): Promise<string> {
  const filePath = path.join(os.tmpdir(), `vision-prepare-test-${width}x${height}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  await sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 80, b: 200 } },
  }).png().toFile(filePath);
  createdFiles.push(filePath);
  return filePath;
}

// 高熵噪声图：PNG 压不动，用来造「尺寸合规但字节超限」的输入。
async function makeNoisyPng(width: number, height: number): Promise<string> {
  const filePath = path.join(os.tmpdir(), `vision-prepare-noise-${width}x${height}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  await sharp({
    create: { width, height, channels: 3, noise: { type: 'gaussian' } },
  }).png().toFile(filePath);
  createdFiles.push(filePath);
  return filePath;
}

function listVisionTempFiles(): string[] {
  return fs
    .readdirSync(os.tmpdir())
    .filter((f) => f.startsWith('code-agent-vision-resized-'))
    .map((f) => path.join(os.tmpdir(), f));
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

describe('prepareImageForVision 字节上限与 sharp 失败契约', () => {
  afterEach(() => {
    loadSharpOverrideMock.mockReset();
  });

  it('未降采样的原图超过 MAX_BYTES → 抛错带上限值，不返回任何字节', async () => {
    // 1500x1500 噪声 ≈ 5.7 MiB > 5 MiB；1500 < MAX_EDGE_PX 且 scaleFactor=1 → 走「不 resize 原图直发」分支
    const src = await makeNoisyPng(1500, 1500);
    expect(fs.statSync(src).size).toBeGreaterThan(VISION_IMAGE.MAX_BYTES);

    // 「不读入内存」（statSync 前置）由 mocked-fs 侧的 readFileSync-not-called 断言覆盖；
    // 真 sharp 侧断言可观察契约：拒绝且错误带上限值，而不是带着 base64 走成功分支。
    await expect(prepareImageForVision(src, 1)).rejects.toThrow(
      'larger than the 5 MiB vision limit',
    );
  });

  it('降采样后仍超 MAX_BYTES → 抛错且不留泄漏的 temp 文件', async () => {
    // 3200x3200 噪声，scaleFactor=2 → 逻辑 1600 > 1568 → resize 到 1568x1568 ≈ 5.1 MiB 仍超限
    const src = await makeNoisyPng(3200, 3200);
    const tmpBefore = listVisionTempFiles();

    await expect(prepareImageForVision(src, 2)).rejects.toThrow('5 MiB vision limit');

    const leaked = listVisionTempFiles().filter((f) => !tmpBefore.includes(f));
    expect(leaked).toEqual([]);
  });

  it('sharp 运行时不可用 → 抛错声明图片未发送，不回退读原始字节', async () => {
    loadSharpOverrideMock.mockReturnValue({
      ok: false,
      error: 'sharp missing in unit test',
      missingPackage: true,
    });
    const src = await makePng(800, 600);

    const err = await prepareImageForVision(src, 1).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('sharp missing in unit test');
    expect((err as Error).message).toContain('the image was not sent');
  });

  it('sharp 步骤抛错 → 错误点名 sharp 失败且图片未发送，不回退原始字节', async () => {
    const failingSharp = () => ({
      metadata: () => Promise.reject(new Error('vips: bad image header')),
    });
    loadSharpOverrideMock.mockReturnValue({ ok: true, sharp: failingSharp });
    const src = await makePng(800, 600);

    const err = await prepareImageForVision(src, 1).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('vips: bad image header');
    expect((err as Error).message).toContain('Sharp image processing failed, the image was not sent');
  });
});
