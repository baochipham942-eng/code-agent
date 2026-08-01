// ============================================================================
// workspace.ipc — 设计画布扩图/去水印 handler 测试（T3）
//
// mock 掉真网络出图（expandImage/removeWatermark）与 DashScope key，
// 保留真 expandScalesForDirection（验证方向→四向 scale 正确透传给 service），
// 断言 handler：入参校验 / 落盘 / key 缺失报错。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SVC = '../../../src/host/services/media/imageGenerationService';

vi.mock('../../../src/host/services/media/imageGenerationService', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/host/services/media/imageGenerationService')>();
  return {
    ...actual, // 保留真 expandScalesForDirection
    getDashscopeApiKey: vi.fn(() => 'sk-test'),
    // listVisualImageModels 用：默认未配（available=false），按需 mockReturnValueOnce 翻为已配
    getZhipuOfficialApiKey: vi.fn(() => undefined),
    getGptImageConfig: vi.fn(() => undefined),
    expandImage: vi.fn(async () => ({ url: 'data:image/png;base64,QUJD', actualModel: 'wanx2.1-imageedit' })), // 'ABC'
    removeWatermark: vi.fn(async () => ({ url: 'data:image/png;base64,QUJD', actualModel: 'wanx2.1-imageedit' })),
    generateImageFromReference: vi.fn(async () => ({
      imageData: 'data:image/png;base64,QUJD',
      actualModel: 'wanx2.1-imageedit',
    })),
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
vi.mock('../../../src/host/config/configPaths', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/host/config/configPaths')>();
  return { ...actual, getUserConfigDir: () => cfg.root };
});

// configService mock：openrouter key 走 getApiKey('openrouter')，默认未配（确定性，不读真配置）。
vi.mock('../../../src/host/services/core/configService', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/host/services/core/configService')>();
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
} from '../../../src/host/ipc/workspace.ipc';
import { handleImportDesignImageFromPath } from '../../../src/host/ipc/workspaceDesignMedia.ipc';

let workDir: string;
let designRoot: string;
let baseImagePath: string;
let outputPath: string;

const VALID_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'design-image-ipc-'));
  cfg.root = workDir; // 设计根 = workDir/design
  designRoot = join(workDir, 'design');
  baseImagePath = join(designRoot, 'run', 'base.png');
  outputPath = join(designRoot, 'run', 'out', 'result.png');
  await mkdir(join(designRoot, 'run'), { recursive: true });
  await writeFile(baseImagePath, Buffer.from('basepng'));
  vi.clearAllMocks();
  // clearAllMocks 不清 mockReturnValue：显式把 key getter 复位到默认（仅 dashscope 配），
  // 防某个测试 mockReturnValue 配 key 后泄漏到后续「按已配 key 标可用」类断言。
  const svcReset = await import(SVC);
  (svcReset.getDashscopeApiKey as any).mockReturnValue('sk-test');
  (svcReset.getZhipuOfficialApiKey as any).mockReturnValue(undefined);
  (svcReset.getGptImageConfig as any).mockReturnValue(undefined);
  const cfgReset = await import('../../../src/host/services/core/configService');
  (cfgReset.getConfigService as any).mockReturnValue({ getApiKey: () => undefined });
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
      // 缺 direction（新契约里 direction 可选，缺失走旧形态分支被 direction 闸拦下）
      handleExpandDesignImage({ baseImagePath, outputPath, ratio: 1.5 }),
    ).rejects.toThrow('expandDesignImage');
  });

  it('方向+比例正确映射为四向 scale 透传给 expandImage，并落盘', async () => {
    const svc = await import(SVC);
    const res = await handleExpandDesignImage({ baseImagePath, outputPath, direction: 'right', ratio: 1.5 });
    // 成本透明补全：扩图回 actualModel + costCny（wanx imageedit 0.14）。
    expect(res).toEqual({ path: outputPath, actualModel: 'wanx2.1-imageedit', costCny: 0.14 });

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

  // 旧形态 ratio=1（滑块最小值）四向全 1 = 什么都不扩的付费空调用，与新形态共用同一道闸。
  it('旧形态 ratio=1 被空操作闸拦下且不触发付费调用', async () => {
    const svc = await import(SVC);
    await expect(
      handleExpandDesignImage({ baseImagePath, outputPath, direction: 'all', ratio: 1 }),
    ).rejects.toThrow(/空操作/);
    expect((svc.expandImage as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
  });
});

describe('handleExpandDesignImage — 四向独立 scale 形态', () => {
  const expandCalls = async () =>
    ((await import(SVC)).expandImage as unknown as { mock: { calls: unknown[][] } }).mock.calls;

  it('四向 scale 原样透传给 expandImage，一次调用完成非对称外扩', async () => {
    // 居中扩成更宽的比例：左右各扩一半（1.25+1.25-1 = 1.5 倍宽），旧形态要两次付费调用才能做到。
    const res = await handleExpandDesignImage({
      baseImagePath,
      outputPath,
      scales: { top: 1, bottom: 1, left: 1.25, right: 1.25 },
    });
    expect(res).toEqual({ path: outputPath, actualModel: 'wanx2.1-imageedit', costCny: 0.14 });
    expect((await expandCalls())[0][0]).toMatchObject({
      topScale: 1,
      bottomScale: 1,
      leftScale: 1.25,
      rightScale: 1.25,
    });
    expect((await readFile(outputPath)).toString()).toBe('ABC');
  });

  it('给了 scales 时忽略 direction/ratio（新形态优先）', async () => {
    await handleExpandDesignImage({
      baseImagePath,
      outputPath,
      direction: 'up',
      ratio: 2,
      scales: { top: 1, bottom: 1, left: 1, right: 1.4 },
    });
    expect((await expandCalls())[0][0]).toMatchObject({ topScale: 1, bottomScale: 1, leftScale: 1, rightScale: 1.4 });
  });

  // 坏输入门：每一种都必须指名道姓报错且零付费调用（静默 clamp = 扩了个寂寞的空调用）。
  const badScales: Array<[string, unknown, RegExp]> = [
    ['上界越界', { top: 2.5, bottom: 1, left: 1, right: 1 }, /scales\.top/],
    ['下界越界', { top: 1, bottom: 0.5, left: 1, right: 1 }, /scales\.bottom/],
    ['NaN', { top: 1, bottom: 1, left: Number.NaN, right: 1 }, /scales\.left/],
    ['Infinity', { top: 1, bottom: 1, left: 1, right: Number.POSITIVE_INFINITY }, /scales\.right/],
    ['字符串数字', { top: '1.5', bottom: 1, left: 1, right: 1 }, /scales\.top/],
    ['缺字段', { top: 1.5, bottom: 1, left: 1 }, /scales\.right/],
    ['null 字段', { top: 1.5, bottom: 1, left: 1, right: null }, /scales\.right/],
    ['scales 非对象', 'nope', /scales 须为/],
    ['scales 为 null', null, /scales 须为/],
    ['四向全 1（空操作）', { top: 1, bottom: 1, left: 1, right: 1 }, /空操作/],
  ];
  for (const [name, scales, pattern] of badScales) {
    it(`坏输入「${name}」被拦下且不触发付费调用`, async () => {
      await expect(
        handleExpandDesignImage({ baseImagePath, outputPath, scales: scales as never }),
      ).rejects.toThrow(pattern);
      expect((await expandCalls()).length).toBe(0);
    });
  }
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
    expect(res).toEqual({ path: outputPath, actualModel: 'wanx2.1-imageedit', costCny: 0.14 });
    expect((svc.removeWatermark as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
    const written = await readFile(outputPath);
    expect(written.toString()).toBe('ABC');
  });
});

describe('handleGenerateDesignImage 模型路由', () => {
  it('model=cogview-4 路由到 cogview engine', async () => {
    const svc = await import(SVC);
    // avoid 语义：cogview 已配 key 才直连 cogview（否则退健康默认）。
    (svc.getZhipuOfficialApiKey as any).mockReturnValue('zhipu-key');
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
    // avoid 语义：flux 已配 openrouter key 才直连 flux。
    const cfgSvc = await import('../../../src/host/services/core/configService');
    (cfgSvc.getConfigService as any).mockReturnValue({ getApiKey: (id: string) => (id === 'openrouter' ? 'or-key' : undefined) });
    await handleGenerateDesignImage({ prompt: 'p', outputPath, model: 'flux-2' });
    const call = (svc.generateImage as any).mock.calls[0];
    expect(call[0]).toBe('flux');
    expect(call[1]).toBe('black-forest-labs/flux.2-klein-4b'); // 非空，否则 flux 报错
  });
  it('未知 model 抛错（registry 守门）', async () => {
    await expect(handleGenerateDesignImage({ prompt: 'p', outputPath, model: 'nope' })).rejects.toThrow();
  });
  it('返回 costCny 按 actualModel 查表（cogview=0.06）', async () => {
    const svc = await import(SVC);
    (svc.getZhipuOfficialApiKey as any).mockReturnValue('zhipu-key');
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

describe('handleGenerateDesignImage 参考图垫图（P1：reference→wanx description_edit）', () => {
  const refDataUrl = 'data:image/png;base64,UkVG'; // 'REF'

  it('带 referenceImageDataUrl 时走参考图编排，不走文生图 generateImage', async () => {
    const svc = await import(SVC);
    await handleGenerateDesignImage({ prompt: '一张落地页', outputPath, referenceImageDataUrl: refDataUrl });
    expect((svc.generateImageFromReference as any).mock.calls.length).toBe(1);
    expect((svc.generateImage as any).mock.calls.length).toBe(0);
    // prompt + 参考图正确透传给 service
    expect((svc.generateImageFromReference as any).mock.calls[0][0]).toMatchObject({
      prompt: '一张落地页',
      referenceImageDataUrl: refDataUrl,
    });
  });

  it('参考图路径 actualModel=wanx2.1-imageedit，costCny=0.14，结果落盘', async () => {
    const res = await handleGenerateDesignImage({ prompt: 'p', outputPath, referenceImageDataUrl: refDataUrl });
    expect(res).toMatchObject({ path: outputPath, actualModel: 'wanx2.1-imageedit', costCny: 0.14 });
    const written = await readFile(outputPath);
    expect(written.toString()).toBe('ABC');
  });

  it('service 抛 DashScope key 缺失时 handler 透传报错', async () => {
    const svc = await import(SVC);
    (svc.generateImageFromReference as any).mockRejectedValueOnce(
      new Error('参考图生成需要百炼（DashScope）API Key。'),
    );
    await expect(
      handleGenerateDesignImage({ prompt: 'p', outputPath, referenceImageDataUrl: refDataUrl }),
    ).rejects.toThrow('DashScope');
  });

  it('参考图路径空白 prompt 抛错且不触发付费调用（防 paid no-op）', async () => {
    const svc = await import(SVC);
    await expect(
      handleGenerateDesignImage({ prompt: '   ', outputPath, referenceImageDataUrl: refDataUrl }),
    ).rejects.toThrow('generateDesignImage');
    expect((svc.generateImageFromReference as any).mock.calls.length).toBe(0);
  });

  it('outputPath 越界时抛错且不触发付费参考图调用', async () => {
    const svc = await import(SVC);
    await expect(
      handleGenerateDesignImage({ prompt: 'p', outputPath: '/tmp/evil.png', referenceImageDataUrl: refDataUrl }),
    ).rejects.toThrow(/越界/);
    expect((svc.generateImageFromReference as any).mock.calls.length).toBe(0);
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
    expect(res).toEqual({ path: outputPath, actualModel: 'wanx2.1-imageedit', costCny: 0.14 });
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
  it('不泄漏任何 key 值（出参只含 id/label/provider/available/source[/sourceLabel]）', async () => {
    const res = await handleListVisualImageModels();
    // 不传 settings → 无桥接项，全部为内置，键集应恰为安全字段（source 是枚举徽标非密钥）。
    for (const m of res.models) {
      expect(Object.keys(m).sort()).toEqual(['available', 'id', 'label', 'provider', 'source']);
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

describe('handleImportDesignImageFromPath', () => {
  let workspaceRoot: string;
  let outsideRoot: string;
  let sourcePath: string;
  let importOutputPath: string;

  beforeEach(async () => {
    workspaceRoot = join(workDir, 'workspace');
    outsideRoot = join(workDir, 'outside');
    sourcePath = join(workspaceRoot, 'media', 'source.png');
    importOutputPath = join(designRoot, 'run', 'assets', 'imported.png');
    await mkdir(join(workspaceRoot, 'media'), { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(sourcePath, VALID_PNG);
  });

  it('拒绝用 .. 从当前工作目录穿越到允许根之外', async () => {
    const outsidePath = join(outsideRoot, 'traversal.png');
    await writeFile(outsidePath, VALID_PNG);
    await mkdir(join(workspaceRoot, 'nested'), { recursive: true });
    const traversalPath = `${workspaceRoot}/nested/../../outside/traversal.png`;

    await expect(
      handleImportDesignImageFromPath({ sourcePath: traversalPath, outputPath: importOutputPath }, workspaceRoot),
    ).rejects.toThrow(/sourcePath.*越界/);
  });

  it('拒绝允许根之外伪装成图片的绝对路径', async () => {
    const outsidePath = join(outsideRoot, 'absolute.png');
    await writeFile(outsidePath, VALID_PNG);

    await expect(
      handleImportDesignImageFromPath({ sourcePath: outsidePath, outputPath: importOutputPath }, workspaceRoot),
    ).rejects.toThrow(/sourcePath.*越界/);
  });

  it('拒绝当前工作目录内指向允许根之外的 symlink', async () => {
    const outsidePath = join(outsideRoot, 'symlink-target.png');
    const linkPath = join(workspaceRoot, 'media', 'escaped.png');
    await writeFile(outsidePath, VALID_PNG);
    await symlink(outsidePath, linkPath);

    await expect(
      handleImportDesignImageFromPath({ sourcePath: linkPath, outputPath: importOutputPath }, workspaceRoot),
    ).rejects.toThrow(/sourcePath.*越界/);
  });

  it('复制允许根内的图片且源与目标逐字节相同', async () => {
    const result = await handleImportDesignImageFromPath(
      { sourcePath, outputPath: importOutputPath },
      workspaceRoot,
    );

    expect(result).toEqual({ path: importOutputPath });
    expect(await readFile(importOutputPath)).toEqual(VALID_PNG);
  });

  it('拒绝越出设计目录的 outputPath', async () => {
    await expect(
      handleImportDesignImageFromPath(
        { sourcePath, outputPath: join(outsideRoot, 'output.png') },
        workspaceRoot,
      ),
    ).rejects.toThrow(/outputPath.*越界/);
  });

  it('源文件不存在时指名 sourcePath 与问题', async () => {
    await expect(
      handleImportDesignImageFromPath(
        { sourcePath: join(workspaceRoot, 'media', 'missing.png'), outputPath: importOutputPath },
        workspaceRoot,
      ),
    ).rejects.toThrow(/sourcePath.*不存在/);
  });

  it('拒绝非图片扩展名', async () => {
    const textPath = join(workspaceRoot, 'media', 'notes.txt');
    await writeFile(textPath, 'not an image');

    await expect(
      handleImportDesignImageFromPath({ sourcePath: textPath, outputPath: importOutputPath }, workspaceRoot),
    ).rejects.toThrow(/sourcePath.*图片类型/);
  });

  it('拒绝扩展名是图片但 magic bytes 不匹配的文件', async () => {
    const fakePngPath = join(workspaceRoot, 'media', 'fake.png');
    await writeFile(fakePngPath, 'plain text disguised as png');

    await expect(
      handleImportDesignImageFromPath({ sourcePath: fakePngPath, outputPath: importOutputPath }, workspaceRoot),
    ).rejects.toThrow(/sourcePath.*文件内容与扩展名不匹配/);
  });
});
