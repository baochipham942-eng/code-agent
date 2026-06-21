// ============================================================================
// workspace.ipc — 设计画布扩图/去水印 handler 测试（T3）
//
// mock 掉真网络出图（expandImage/removeWatermark）与 DashScope key，
// 保留真 expandScalesForDirection（验证方向→四向 scale 正确透传给 service），
// 断言 handler：入参校验 / 落盘 / key 缺失报错。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SVC = '../../../src/main/services/media/imageGenerationService';

vi.mock('../../../src/main/services/media/imageGenerationService', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/main/services/media/imageGenerationService')>();
  return {
    ...actual, // 保留真 expandScalesForDirection
    getDashscopeApiKey: vi.fn(() => 'sk-test'),
    expandImage: vi.fn(async () => ({ url: 'data:image/png;base64,QUJD' })), // 'ABC'
    removeWatermark: vi.fn(async () => ({ url: 'data:image/png;base64,QUJD' })),
    downloadImageAsBase64: vi.fn(async (u: string) => u),
    isImageUrl: vi.fn(() => false),
  };
});

import {
  handleExpandDesignImage,
  handleRemoveWatermarkDesignImage,
} from '../../../src/main/ipc/workspace.ipc';

let workDir: string;
let baseImagePath: string;
let outputPath: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'design-image-ipc-'));
  baseImagePath = join(workDir, 'base.png');
  outputPath = join(workDir, 'out', 'result.png');
  await writeFile(baseImagePath, Buffer.from('basepng'));
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('handleExpandDesignImage', () => {
  it('缺少必填项时抛错', async () => {
    await expect(
      handleExpandDesignImage({ baseImagePath: '', outputPath, direction: 'up', ratio: 1.5 }),
    ).rejects.toThrow('expandDesignImage');
    await expect(
      // @ts-expect-error 故意缺 direction
      handleExpandDesignImage({ baseImagePath, outputPath, ratio: 1.5 }),
    ).rejects.toThrow('expandDesignImage');
  });

  it('方向+比例正确映射为四向 scale 透传给 expandImage，并落盘', async () => {
    const svc = await import(SVC);
    const res = await handleExpandDesignImage({ baseImagePath, outputPath, direction: 'right', ratio: 1.5 });
    expect(res).toEqual({ path: outputPath });

    const call = (svc.expandImage as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<string, number>;
    expect(call).toMatchObject({ topScale: 1, bottomScale: 1, leftScale: 1, rightScale: 1.5 });

    const written = await readFile(outputPath);
    expect(written.toString()).toBe('ABC'); // base64 QUJD 解出
  });

  it('非法 direction 抛错且不触发付费出图调用（防 no-op 扩图）', async () => {
    const svc = await import(SVC);
    await expect(
      // @ts-expect-error 故意传联合类型外的 direction
      handleExpandDesignImage({ baseImagePath, outputPath, direction: 'top', ratio: 1.5 }),
    ).rejects.toThrow(/direction/);
    expect((svc.expandImage as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
  });

  it('ratio 非有限数(NaN)抛错且不触发付费调用', async () => {
    const svc = await import(SVC);
    await expect(
      handleExpandDesignImage({ baseImagePath, outputPath, direction: 'all', ratio: Number.NaN }),
    ).rejects.toThrow(/ratio/);
    expect((svc.expandImage as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
  });

  it('DashScope key 缺失时报错', async () => {
    const svc = await import(SVC);
    (svc.getDashscopeApiKey as unknown as { mockReturnValueOnce: (v: unknown) => void }).mockReturnValueOnce(undefined);
    await expect(
      handleExpandDesignImage({ baseImagePath, outputPath, direction: 'all', ratio: 1.5 }),
    ).rejects.toThrow('DashScope');
  });
});

describe('handleRemoveWatermarkDesignImage', () => {
  it('缺少必填项时抛错', async () => {
    await expect(
      handleRemoveWatermarkDesignImage({ baseImagePath: '', outputPath }),
    ).rejects.toThrow('removeWatermarkDesignImage');
  });

  it('调用 removeWatermark 并落盘', async () => {
    const svc = await import(SVC);
    const res = await handleRemoveWatermarkDesignImage({ baseImagePath, outputPath });
    expect(res).toEqual({ path: outputPath });
    expect((svc.removeWatermark as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
    const written = await readFile(outputPath);
    expect(written.toString()).toBe('ABC');
  });
});
