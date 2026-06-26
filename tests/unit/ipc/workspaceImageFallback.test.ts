// ============================================================================
// workspace.ipc — 图像「健康优先选型 + 余额类单步兜底」（2a #3）
//
// 断言：
//  · 默认选型只在已配 key 的内置模型里挑（未配 wanx 时不盲选 wanx）；
//  · chosen 模型遇「余额/配额」错误 → 换下一个健康模型重试一次，actualModel/cost 反映兜底模型；
//  · auth 等非余额错误不触发换模型（不重复付费）；
//  · 无可兜底模型时原样抛错，不循环。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimateImageCostCny } from '../../../src/shared/media/imageCost';

const health = vi.hoisted(() => ({
  dashscope: undefined as string | undefined,
  zhipu: undefined as string | undefined,
  gptimage: undefined as { base: string; key: string } | undefined,
  openrouter: undefined as string | undefined,
}));

// generateImage 行为可注入：按 engine 决定抛错/成功，并记录调用的 engine 序列。
const gen = vi.hoisted(() => ({
  calls: [] as string[],
  impl: null as null | ((engine: string) => Promise<{ imageData: string; actualModel: string }>),
}));

vi.mock('../../../src/host/services/media/imageGenerationService', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/host/services/media/imageGenerationService')>();
  return {
    ...actual,
    getDashscopeApiKey: vi.fn(() => health.dashscope),
    getZhipuOfficialApiKey: vi.fn(() => health.zhipu),
    getGptImageConfig: vi.fn(() => health.gptimage),
    getMinimaxApiKey: vi.fn(() => undefined),
    generateImage: vi.fn(async (engine: string) => {
      gen.calls.push(engine);
      if (!gen.impl) throw new Error('no impl');
      return gen.impl(engine);
    }),
    downloadImageAsBase64: vi.fn(async (u: string) => u),
    isImageUrl: vi.fn((d: string) => d.startsWith('http')),
  };
});

vi.mock('../../../src/host/services/media/customImageModelRegistry', () => ({
  getCustomImageModel: vi.fn(async () => null),
  getCustomModelApiKey: vi.fn(),
  listCustomImageModels: vi.fn(async () => []),
  toVisualImageModel: (m: { id: string; label: string }) => ({ id: m.id, label: m.label, provider: 'custom', engine: 'openai-compat', caps: ['t2i'] }),
}));

const cfg = vi.hoisted(() => ({ root: '' }));
vi.mock('../../../src/host/config/configPaths', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/host/config/configPaths')>();
  return { ...actual, getUserConfigDir: () => cfg.root };
});

vi.mock('../../../src/host/services/core/configService', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/host/services/core/configService')>();
  return { ...actual, getConfigService: vi.fn(() => ({ getApiKey: (k: string) => (k === 'openrouter' ? health.openrouter : undefined) })) };
});

import { handleGenerateDesignImage } from '../../../src/host/ipc/workspace.ipc';

const PNG = 'data:image/png;base64,QUJD';
let workDir: string;
let outputPath: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'img-fallback-ipc-'));
  cfg.root = workDir;
  outputPath = join(workDir, 'design', 'run', 'out.png');
  await mkdir(join(workDir, 'design', 'run'), { recursive: true });
  health.dashscope = undefined;
  health.zhipu = undefined;
  health.gptimage = undefined;
  health.openrouter = undefined;
  gen.calls = [];
  gen.impl = null;
  vi.clearAllMocks();
});

describe('handleGenerateDesignImage — 余额类单步兜底', () => {
  it('wanx 余额不足 → 换 gpt-image-2 重试一次，actualModel/cost 反映兜底模型', async () => {
    health.dashscope = 'sk-dash';
    health.gptimage = { base: 'https://x', key: 'k' };
    gen.impl = async (engine) => {
      if (engine === 'wanx') throw new Error('通义万相提交失败: 400 - InsufficientBalance: 余额不足');
      return { imageData: PNG, actualModel: 'gpt-image-2' };
    };

    const res = await handleGenerateDesignImage({ prompt: 'a cat', outputPath });

    expect(gen.calls).toEqual(['wanx', 'gptimage']); // 先 wanx 后兜底 gptimage，仅两次
    expect(res.actualModel).toBe('gpt-image-2');
    expect(res.costCny).toBe(estimateImageCostCny('gpt-image-2'));
  });

  it('auth 错误不触发换模型（不重复付费）', async () => {
    health.dashscope = 'sk-dash';
    health.gptimage = { base: 'https://x', key: 'k' };
    gen.impl = async () => { throw new Error('401 Unauthorized: invalid api key'); };

    await expect(handleGenerateDesignImage({ prompt: 'a cat', outputPath })).rejects.toThrow(/401|Unauthorized/);
    expect(gen.calls).toEqual(['wanx']); // 只调一次，不兜底
  });

  it('余额不足但无其它健康模型 → 原样抛错，不循环', async () => {
    health.dashscope = 'sk-dash'; // 仅 wanx 健康
    gen.impl = async () => { throw new Error('InsufficientBalance 余额不足'); };

    await expect(handleGenerateDesignImage({ prompt: 'a cat', outputPath })).rejects.toThrow(/余额不足/);
    expect(gen.calls).toEqual(['wanx']);
  });

  it('未配 wanx 但配了 cogview → 默认选型直接走 cogview（不盲选 wanx）', async () => {
    health.zhipu = 'zk'; // 仅 cogview 健康
    gen.impl = async () => ({ imageData: PNG, actualModel: 'cogview-4-250304' });

    const res = await handleGenerateDesignImage({ prompt: 'a cat', outputPath });

    expect(gen.calls).toEqual(['cogview']); // 健康选型，不碰 wanx
    expect(res.actualModel).toBe('cogview-4-250304');
  });

  it('兜底模型也失败 → 第二个错误冒泡，仅两次调用不循环（审计 LOW-A）', async () => {
    health.dashscope = 'sk-dash';
    health.gptimage = { base: 'https://x', key: 'k' };
    gen.impl = async (engine) => {
      if (engine === 'wanx') throw new Error('InsufficientBalance 余额不足');
      throw new Error('gpt-image-2 生成失败: 500 - upstream error');
    };

    await expect(handleGenerateDesignImage({ prompt: 'a cat', outputPath })).rejects.toThrow(/upstream error/);
    expect(gen.calls).toEqual(['wanx', 'gptimage']); // 兜底一次即止，第二次错误原样冒泡
  });

  it('显式指定已配模型 → 尊重选择，成功不兜底', async () => {
    health.dashscope = 'sk-dash';
    health.gptimage = { base: 'https://x', key: 'k' };
    gen.impl = async () => ({ imageData: PNG, actualModel: 'gpt-image-2' });

    const res = await handleGenerateDesignImage({ prompt: 'a cat', outputPath, model: 'gpt-image-2' });

    expect(gen.calls).toEqual(['gptimage']);
    expect(res.actualModel).toBe('gpt-image-2');
  });
});
