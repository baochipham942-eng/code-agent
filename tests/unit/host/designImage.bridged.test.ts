// ============================================================================
// 桥接图像模型出图（多模态桥接 P2 Task 8）
//
// `provider:model` 桥接 id 应走 openai-compat 引擎，端点取自源聊天 provider
// 的 baseUrl + key（不进 custom/内置注册表，因二者 id 不含冒号）。
//
// 测试基建：assertWithinDesignDir 以 <getUserConfigDir>/design 为根。复用现有
// 设计图测试的「mock getUserConfigDir 指向临时目录」做法，outputPath 落该根内，
// 避免撞越界守卫（不硬用 os.tmpdir() 裸路径）。
// ============================================================================

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import path from 'path';
import os from 'os';
import { promises as fsp } from 'fs';

const calls: any[] = [];

vi.mock('../../../src/host/services/media/imageGenerationService', () => ({
  generateImageOpenAICompat: (a: any) => {
    calls.push(a);
    return Promise.resolve({ imageData: 'data:image/png;base64,AAAA', actualModel: a.modelName });
  },
  downloadImageAsBase64: (u: string) => Promise.resolve(u),
  isImageUrl: () => false,
}));

vi.mock('../../../src/shared/media/imageCost', () => ({
  estimateImageCostCny: () => 0.14,
}));

vi.mock('../../../src/host/services/media/bridgedEndpoint', () => ({
  resolveBridgedEndpoint: () => ({ baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: 'sk-agnes' }),
}));

// 设计目录根可变 mock：让 assertWithinDesignDir 以 <cfg.root>/design 为边界。
const cfg = vi.hoisted(() => ({ root: '' }));
vi.mock('../../../src/host/config/configPaths', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/host/config/configPaths')>();
  return { ...actual, getUserConfigDir: () => cfg.root };
});

let designRoot: string;

beforeEach(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'design-bridged-'));
  cfg.root = dir;
  designRoot = path.join(dir, 'design');
  await fsp.mkdir(designRoot, { recursive: true });
  calls.length = 0;
});

afterEach(async () => {
  await fsp.rm(cfg.root, { recursive: true, force: true });
});

describe('桥接模型出图', () => {
  it('provider:model id 走 openai-compat，用桥接 modelName + 真落盘', async () => {
    const { handleGenerateDesignImage } = await import('../../../src/host/ipc/workspaceDesignMedia.ipc');
    const outputPath = path.join(designRoot, 'out.png');
    const settings = { models: { providers: { 'custom-agnes': { baseUrl: 'https://apihub.agnes-ai.com/v1' } } } } as any;
    const res = await handleGenerateDesignImage(
      { prompt: 'a cat', outputPath, model: 'custom-agnes:agnes-image-2.1-flash' },
      () => settings,
    );
    expect(calls[0]).toMatchObject({
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      apiKey: 'sk-agnes',
      modelName: 'agnes-image-2.1-flash',
    });
    expect(res.actualModel).toBe('agnes-image-2.1-flash');
    await fsp.access(outputPath); // 真落盘
  });

  it('桥接模型 + 参考图垫图 显式拒绝（仅文生图）', async () => {
    const { handleGenerateDesignImage } = await import('../../../src/host/ipc/workspaceDesignMedia.ipc');
    const outputPath = path.join(designRoot, 'o.png');
    await expect(handleGenerateDesignImage(
      {
        prompt: 'x',
        outputPath,
        model: 'custom-agnes:agnes-image-2.1-flash',
        referenceImageDataUrl: 'data:image/png;base64,AAAA',
      },
      () => ({ models: { providers: { 'custom-agnes': { baseUrl: 'https://apihub.agnes-ai.com/v1' } } } } as any),
    )).rejects.toThrow();
  });
});
