// ============================================================================
// workspace.ipc — 设计画布扩图/去水印 handler 测试（T3）
//
// mock 掉真网络出图（expandImage/removeWatermark）与 DashScope key，
// 保留真 expandScalesForDirection（验证方向→四向 scale 正确透传给 service），
// 断言 handler：入参校验 / 落盘 / key 缺失报错。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SVC = '../../../src/main/services/media/imageGenerationService';

vi.mock('../../../src/main/services/media/imageGenerationService', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/main/services/media/imageGenerationService')>();
  return {
    ...actual, // 保留真 expandScalesForDirection
    getDashscopeApiKey: vi.fn(() => 'sk-test'),
    // listVisualImageModels 用：默认未配（available=false），按需 mockReturnValueOnce 翻为已配
    getZhipuOfficialApiKey: vi.fn(() => undefined),
    getGptImageConfig: vi.fn(() => undefined),
    expandImage: vi.fn(async () => ({ url: 'data:image/png;base64,QUJD' })), // 'ABC'
    removeWatermark: vi.fn(async () => ({ url: 'data:image/png;base64,QUJD' })),
    editImageByAnnotation: vi.fn(async () => ({ imageData: 'data:image/png;base64,QUJD', actualModel: 'gpt-image-2' })),
    downloadImageAsBase64: vi.fn(async (u: string) => u),
    isImageUrl: vi.fn(() => false),
    generateImage: vi.fn(async (engine: string) => ({
      imageData: 'data:image/png;base64,QUJD',
      actualModel: engine === 'cogview' ? 'cogview-4-250304'
        : engine === 'flux' ? 'black-forest-labs/flux.2-klein-4b'
        : engine === 'gptimage' ? 'gpt-image-2' : 'wanx2.1-t2i-turbo',
    })),
  };
});

// 设计目录根可变 mock：让 handler 的路径越界守卫以 <cfg.root>/design 为边界（M1）。
const cfg = vi.hoisted(() => ({ root: '' }));
vi.mock('../../../src/main/config/configPaths', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/main/config/configPaths')>();
  return { ...actual, getUserConfigDir: () => cfg.root };
});

// configService mock：openrouter key 走 getApiKey('openrouter')，默认未配（确定性，不读真配置）。
vi.mock('../../../src/main/services/core/configService', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/main/services/core/configService')>();
  return {
    ...actual,
    getConfigService: vi.fn(() => ({ getApiKey: vi.fn(() => undefined) })),
  };
});

import {
  handleExpandDesignImage,
  handleRemoveWatermarkDesignImage,
  handleGenerateDesignImage,
  handleListVisualImageModels,
  handleEditImageByAnnotation,
} from '../../../src/main/ipc/workspace.ipc';

let workDir: string;
let designRoot: string;
let baseImagePath: string;
let outputPath: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'design-image-ipc-'));
  cfg.root = workDir; // 设计根 = workDir/design
  designRoot = join(workDir, 'design');
  baseImagePath = join(designRoot, 'run', 'base.png');
  outputPath = join(designRoot, 'run', 'out', 'result.png');
  await mkdir(join(designRoot, 'run'), { recursive: true });
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

describe('handleGenerateDesignImage 模型路由', () => {
  it('model=cogview-4 路由到 cogview engine', async () => {
    const svc = await import(SVC);
    await handleGenerateDesignImage({ prompt: 'p', outputPath, model: 'cogview-4' });
    const call = (svc.generateImage as any).mock.calls[0];
    expect(call[0]).toBe('cogview');
  });
  it('缺 model 时回退默认 wanx engine', async () => {
    const svc = await import(SVC);
    await handleGenerateDesignImage({ prompt: 'p', outputPath });
    expect((svc.generateImage as any).mock.calls[0][0]).toBe('wanx');
  });
  it('model=flux-2 路由到 flux engine 且传 DESIGN_FLUX_MODEL 作 fluxModel 入参', async () => {
    const svc = await import(SVC);
    await handleGenerateDesignImage({ prompt: 'p', outputPath, model: 'flux-2' });
    const call = (svc.generateImage as any).mock.calls[0];
    expect(call[0]).toBe('flux');
    expect(call[1]).toBe('black-forest-labs/flux.2-klein-4b'); // 非空，否则 flux 报错
  });
  it('未知 model 抛错（registry 守门）', async () => {
    await expect(handleGenerateDesignImage({ prompt: 'p', outputPath, model: 'nope' })).rejects.toThrow();
  });
  it('返回 costCny 按 actualModel 查表（cogview=0.06）', async () => {
    const res = await handleGenerateDesignImage({ prompt: 'p', outputPath, model: 'cogview-4' });
    expect(res.costCny).toBe(0.06);
  });
  it('空白 prompt 抛错且不触发付费出图调用（防 paid no-op）', async () => {
    const svc = await import(SVC);
    await expect(
      handleGenerateDesignImage({ prompt: '   ', outputPath, model: 'wanx-t2i' }),
    ).rejects.toThrow('generateDesignImage');
    expect((svc.generateImage as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
  });
});

describe('路径越界守卫（M1：baseImagePath/outputPath 必须在设计目录内）', () => {
  it('expand: outputPath 越出设计目录时抛错且不触发付费调用', async () => {
    const svc = await import(SVC);
    await expect(
      handleExpandDesignImage({ baseImagePath, outputPath: join(workDir, '..', 'evil.png'), direction: 'all', ratio: 1.5 }),
    ).rejects.toThrow(/越界/);
    expect((svc.expandImage as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
  });

  it('expand: baseImagePath 越出设计目录(读任意文件外泄)时抛错', async () => {
    await expect(
      handleExpandDesignImage({ baseImagePath: '/etc/passwd', outputPath, direction: 'all', ratio: 1.5 }),
    ).rejects.toThrow(/越界/);
  });

  it('removeWatermark: outputPath 越界(覆盖任意文件)时抛错', async () => {
    await expect(
      handleRemoveWatermarkDesignImage({ baseImagePath, outputPath: '/tmp/evil-overwrite.png' }),
    ).rejects.toThrow(/越界/);
  });

  it('设计目录内的正常路径放行（不误伤）', async () => {
    const res = await handleRemoveWatermarkDesignImage({ baseImagePath, outputPath });
    expect(res).toEqual({ path: outputPath });
  });
});

describe('handleListVisualImageModels（按已配 key 标可用）', () => {
  it('返回全部模型，仅 dashscope 已配时只有 wanx available', async () => {
    // dashscope=truthy(默认 sk-test), zhipu/openrouter/gptimage=undefined
    const res = await handleListVisualImageModels();
    const byId = Object.fromEntries(res.models.map((m) => [m.id, m]));
    expect(byId['wanx-t2i'].available).toBe(true);
    expect(byId['cogview-4'].available).toBe(false);
    expect(byId['flux-2'].available).toBe(false);
    expect(byId['gpt-image-2'].available).toBe(false);
    // 每项带 id/label/provider
    expect(byId['wanx-t2i']).toMatchObject({ id: 'wanx-t2i', provider: 'dashscope', label: expect.any(String) });
  });
  it('zhipu 已配时 cogview-4 available=true', async () => {
    const svc = await import(SVC);
    (svc.getZhipuOfficialApiKey as any).mockReturnValueOnce('zhipu-key');
    const res = await handleListVisualImageModels();
    const byId = Object.fromEntries(res.models.map((m) => [m.id, m]));
    expect(byId['cogview-4'].available).toBe(true);
  });
  it('gptimage 已配时 gpt-image-2 available=true', async () => {
    const svc = await import(SVC);
    (svc.getGptImageConfig as any).mockReturnValueOnce({ base: 'https://x', key: 'k' });
    const res = await handleListVisualImageModels();
    const byId = Object.fromEntries(res.models.map((m) => [m.id, m]));
    expect(byId['gpt-image-2'].available).toBe(true);
  });
  it('不泄漏任何 key 值（出参只含 id/label/provider/available）', async () => {
    const res = await handleListVisualImageModels();
    for (const m of res.models) {
      expect(Object.keys(m).sort()).toEqual(['available', 'id', 'label', 'provider']);
    }
  });
});

describe('handleEditImageByAnnotation', () => {
  it('cap 守门：非 annotEdit 模型抛错且不触发付费调用', async () => {
    const svc = await import(SVC);
    await expect(
      handleEditImageByAnnotation({ model: 'wanx-t2i', annotatedImageDataUrl: 'data:image/png;base64,QUJD', instruction: 'x', outputPath }),
    ).rejects.toThrow(/标注重绘|不支持/);
    expect((svc.editImageByAnnotation as any).mock.calls.length).toBe(0);
  });
  it('annotEdit 模型(gpt-image-2)走通：调 service 并落盘 + 回 costCny', async () => {
    const res = await handleEditImageByAnnotation({ model: 'gpt-image-2', annotatedImageDataUrl: 'data:image/png;base64,QUJD', instruction: '把 logo 改成猫头', outputPath });
    expect(res).toMatchObject({ path: outputPath, actualModel: 'gpt-image-2', costCny: 0.25 });
    const written = await readFile(outputPath);
    expect(written.toString()).toBe('ABC');
  });
  it('空白 instruction 抛错且不触发付费调用（防 paid no-op）', async () => {
    const svc = await import(SVC);
    await expect(
      handleEditImageByAnnotation({ model: 'gpt-image-2', annotatedImageDataUrl: 'data:image/png;base64,QUJD', instruction: '   ', outputPath }),
    ).rejects.toThrow(/instruction|指令/);
    expect((svc.editImageByAnnotation as any).mock.calls.length).toBe(0);
  });
  it('outputPath 越界抛错且不触发付费调用', async () => {
    const svc = await import(SVC);
    await expect(
      handleEditImageByAnnotation({ model: 'gpt-image-2', annotatedImageDataUrl: 'data:image/png;base64,QUJD', instruction: 'x', outputPath: '/tmp/evil.png' }),
    ).rejects.toThrow(/越界/);
    expect((svc.editImageByAnnotation as any).mock.calls.length).toBe(0);
  });
});
