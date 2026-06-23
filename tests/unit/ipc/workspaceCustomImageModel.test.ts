// ============================================================================
// workspace.ipc — 自定义生图模型路由 + 管理 handler（借鉴项① Phase2）
//
// 断言：custom id 走 generateImageOpenAICompat 独立分支（不进 imageEngineForModel/generateImage）；
// 未配 key / 参考图垫图（custom 不支持）显式拦；listVisualImageModels 合并 custom；
// save/list/delete 管理 handler 正确编排注册表 + key 存储。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SVC = '../../../src/main/services/media/imageGenerationService';
const REG = '../../../src/main/services/media/customImageModelRegistry';

vi.mock('../../../src/main/services/media/imageGenerationService', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/main/services/media/imageGenerationService')>();
  return {
    ...actual,
    getDashscopeApiKey: vi.fn(() => 'sk-test'),
    getZhipuOfficialApiKey: vi.fn(() => undefined),
    getGptImageConfig: vi.fn(() => undefined),
    getMinimaxApiKey: vi.fn(() => undefined),
    generateImageOpenAICompat: vi.fn(async () => ({ imageData: 'data:image/png;base64,QUJD', actualModel: 'sdxl' })),
    downloadImageAsBase64: vi.fn(async (u: string) => u),
    isImageUrl: vi.fn((d: string) => d.startsWith('http')),
  };
});

vi.mock('../../../src/main/services/media/customImageModelRegistry', () => ({
  getCustomImageModel: vi.fn(),
  getCustomModelApiKey: vi.fn(),
  listCustomImageModels: vi.fn(async () => []),
  saveCustomImageModel: vi.fn(async () => ({ id: 'sdxl-abc' })),
  deleteCustomImageModel: vi.fn(async () => ({ ok: true })),
  setCustomModelApiKey: vi.fn(),
  deleteCustomModelApiKey: vi.fn(),
  toVisualImageModel: (m: { id: string; label: string }) => ({ id: m.id, label: m.label, provider: 'custom', engine: 'openai-compat', caps: ['t2i'] }),
}));

const cfg = vi.hoisted(() => ({ root: '' }));
vi.mock('../../../src/main/config/configPaths', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/main/config/configPaths')>();
  return { ...actual, getUserConfigDir: () => cfg.root };
});

vi.mock('../../../src/main/services/core/configService', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/main/services/core/configService')>();
  return { ...actual, getConfigService: vi.fn(() => ({ getApiKey: vi.fn(() => undefined) })) };
});

import {
  handleGenerateDesignImage,
  handleListVisualImageModels,
  handleSaveCustomImageModel,
  handleListCustomImageModels,
  handleDeleteCustomImageModel,
  handleDownloadFile,
} from '../../../src/main/ipc/workspace.ipc';

const CUSTOM = { id: 'sdxl-abc', label: '我的 SDXL', baseUrl: 'https://api.x.com/v1', modelName: 'sdxl', createdAt: 0, updatedAt: 0 };

let workDir: string;
let outputPath: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'custom-img-ipc-'));
  cfg.root = workDir;
  outputPath = join(workDir, 'design', 'run', 'out.png');
  await mkdir(join(workDir, 'design', 'run'), { recursive: true });
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('handleGenerateDesignImage 自定义模型路由', () => {
  it('custom id 走 generateImageOpenAICompat，不走 generateImage，落盘 + 回 actualModel/costCny', async () => {
    const svc = await import(SVC);
    const reg = await import(REG);
    (reg.getCustomImageModel as any).mockResolvedValue(CUSTOM);
    (reg.getCustomModelApiKey as any).mockReturnValue('sk-user');

    const res = await handleGenerateDesignImage({ prompt: '一只猫', outputPath, model: 'sdxl-abc' });

    expect((svc.generateImageOpenAICompat as any).mock.calls.length).toBe(1);
    expect((svc.generateImage as any).mock?.calls?.length ?? 0).toBe(0);
    // baseUrl/key/modelName 正确透传
    expect((svc.generateImageOpenAICompat as any).mock.calls[0][0]).toMatchObject({
      baseUrl: 'https://api.x.com/v1', apiKey: 'sk-user', modelName: 'sdxl', prompt: '一只猫',
    });
    expect(res).toMatchObject({ path: outputPath, actualModel: 'sdxl' });
    expect((await readFile(outputPath)).toString()).toBe('ABC');
  });

  it('custom 模型 costCnyPerImage 覆盖时按覆盖值，否则 default 0.14', async () => {
    const reg = await import(REG);
    (reg.getCustomModelApiKey as any).mockReturnValue('sk-user');
    (reg.getCustomImageModel as any).mockResolvedValue({ ...CUSTOM, costCnyPerImage: 0.5 });
    expect((await handleGenerateDesignImage({ prompt: 'p', outputPath, model: 'sdxl-abc' })).costCny).toBe(0.5);

    (reg.getCustomImageModel as any).mockResolvedValue(CUSTOM); // 无覆盖
    expect((await handleGenerateDesignImage({ prompt: 'p', outputPath, model: 'sdxl-abc' })).costCny).toBe(0.14);
  });

  it('custom 未配 key 抛错且不触发付费调用', async () => {
    const svc = await import(SVC);
    const reg = await import(REG);
    (reg.getCustomImageModel as any).mockResolvedValue(CUSTOM);
    (reg.getCustomModelApiKey as any).mockReturnValue(undefined);
    await expect(handleGenerateDesignImage({ prompt: 'p', outputPath, model: 'sdxl-abc' })).rejects.toThrow(/Key|key/);
    expect((svc.generateImageOpenAICompat as any).mock.calls.length).toBe(0);
  });

  it('custom + 参考图垫图 显式拦（自定义端点不支持参考图，审计修订1）', async () => {
    const svc = await import(SVC);
    const reg = await import(REG);
    (reg.getCustomImageModel as any).mockResolvedValue(CUSTOM);
    (reg.getCustomModelApiKey as any).mockReturnValue('sk-user');
    await expect(
      handleGenerateDesignImage({ prompt: 'p', outputPath, model: 'sdxl-abc', referenceImageDataUrl: 'data:image/png;base64,UkVG' }),
    ).rejects.toThrow(/参考图|不支持/);
    expect((svc.generateImageOpenAICompat as any).mock.calls.length).toBe(0);
    expect((svc.generateImageFromReference as any).mock?.calls?.length ?? 0).toBe(0);
  });

  it('custom outputPath 越界抛错且不触发付费调用', async () => {
    const svc = await import(SVC);
    const reg = await import(REG);
    (reg.getCustomImageModel as any).mockResolvedValue(CUSTOM);
    (reg.getCustomModelApiKey as any).mockReturnValue('sk-user');
    await expect(
      handleGenerateDesignImage({ prompt: 'p', outputPath: '/tmp/evil.png', model: 'sdxl-abc' }),
    ).rejects.toThrow(/越界/);
    expect((svc.generateImageOpenAICompat as any).mock.calls.length).toBe(0);
  });
});

describe('handleListVisualImageModels 合并 custom', () => {
  it('内置 + 自定义模型一起返回，custom available 看 key 是否配', async () => {
    const reg = await import(REG);
    (reg.listCustomImageModels as any).mockResolvedValue([CUSTOM]);
    (reg.getCustomModelApiKey as any).mockReturnValue('sk-user'); // 已配
    const res = await handleListVisualImageModels();
    const byId = Object.fromEntries(res.models.map((m: any) => [m.id, m]));
    expect(byId['wanx-t2i']).toBeTruthy(); // 内置仍在
    expect(byId['sdxl-abc']).toMatchObject({ provider: 'custom', available: true });
  });

  it('custom 未配 key 时 available=false', async () => {
    const reg = await import(REG);
    (reg.listCustomImageModels as any).mockResolvedValue([CUSTOM]);
    (reg.getCustomModelApiKey as any).mockReturnValue(undefined);
    const res = await handleListVisualImageModels();
    const byId = Object.fromEntries(res.models.map((m: any) => [m.id, m]));
    expect(byId['sdxl-abc'].available).toBe(false);
  });
});

describe('管理 handler：save / list / delete', () => {
  it('handleSaveCustomImageModel 落盘注册表 + 存 key，返回 id', async () => {
    const reg = await import(REG);
    const res = await handleSaveCustomImageModel({ label: '我的 SDXL', baseUrl: 'https://api.x.com/v1', modelName: 'sdxl', apiKey: 'sk-user' });
    expect(res).toEqual({ id: 'sdxl-abc' });
    expect((reg.saveCustomImageModel as any).mock.calls[0][0]).toMatchObject({ label: '我的 SDXL', baseUrl: 'https://api.x.com/v1', modelName: 'sdxl' });
    expect((reg.setCustomModelApiKey as any).mock.calls[0]).toEqual(['sdxl-abc', 'sk-user']);
  });

  it('handleSaveCustomImageModel 空 apiKey 抛错且不落盘', async () => {
    const reg = await import(REG);
    await expect(
      handleSaveCustomImageModel({ label: 'X', baseUrl: 'https://api.x.com/v1', modelName: 'm', apiKey: '  ' }),
    ).rejects.toThrow(/Key|key/);
    expect((reg.saveCustomImageModel as any).mock.calls.length).toBe(0);
  });

  it('handleListCustomImageModels 返回 metadata + available，不含 key/baseUrl 泄漏到 available 判断之外', async () => {
    const reg = await import(REG);
    (reg.listCustomImageModels as any).mockResolvedValue([CUSTOM]);
    (reg.getCustomModelApiKey as any).mockReturnValue('sk-user');
    const res = await handleListCustomImageModels();
    expect(res.models[0]).toMatchObject({ id: 'sdxl-abc', label: '我的 SDXL', baseUrl: 'https://api.x.com/v1', modelName: 'sdxl', available: true });
  });

  it('handleDeleteCustomImageModel 转发注册表删除', async () => {
    const reg = await import(REG);
    const res = await handleDeleteCustomImageModel({ id: 'sdxl-abc' });
    expect(res).toEqual({ ok: true });
    expect((reg.deleteCustomImageModel as any).mock.calls[0]).toEqual(['sdxl-abc']);
  });
});

describe('handleDownloadFile SSRF 收口（审计修订2）', () => {
  it('私网/元数据 URL 在 fetch 前被拦', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await expect(handleDownloadFile({ url: 'http://169.254.169.254/latest/meta-data' })).rejects.toThrow();
    await expect(handleDownloadFile({ url: 'https://127.0.0.1/x' })).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
