// ============================================================================
// 多模态桥接 P3 · Task 12 — handleGenerateDesignVideo 桥接 / custom 视频分支
//
// `provider:model` 桥接 id → openai-compat 视频引擎（端点取自源聊天 provider）。
// custom 视频模型（注册表命中）→ 同样走 generateVideoOpenAICompat，补完断链的执行。
// 内置 videoModelById（无冒号）不误伤。mock 真网络出片，断言落盘 + actualModel + 不走内置。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../src/host/services/media/videoGenerationService', () => ({
  generateVideoOpenAICompat: vi.fn((a: { modelName: string }) =>
    Promise.resolve({ url: 'https://v/u.mp4', actualModel: a.modelName }),
  ),
  generateVideo: vi.fn(() => Promise.reject(new Error('不应走内置'))),
  downloadVideoAsBuffer: vi.fn(() => Promise.resolve(Buffer.from('mp4-bytes'))),
}));

vi.mock('../../../src/host/services/media/bridgedEndpoint', () => ({
  resolveBridgedEndpoint: vi.fn(() => ({ baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: 'sk' })),
}));

// custom 视频注册表：默认无命中（getCustomVideoModel → null），按用例 mockResolvedValueOnce 翻为命中。
vi.mock('../../../src/host/services/media/customVideoModelRegistry', () => ({
  getCustomVideoModel: vi.fn(() => Promise.resolve(null)),
  getCustomVideoModelApiKey: vi.fn(() => undefined),
}));

// 设计目录根可变 mock：让 handler 的 assertWithinDesignDir 越界守卫以 <cfg.root>/design 为边界。
const cfg = vi.hoisted(() => ({ root: '' }));
vi.mock('../../../src/host/config/configPaths', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/host/config/configPaths')>();
  return { ...actual, getUserConfigDir: () => cfg.root };
});

const VIDEO_SVC = '../../../src/host/services/media/videoGenerationService';
const VIDEO_REG = '../../../src/host/services/media/customVideoModelRegistry';

let workDir: string;
let designRoot: string;
let outputPath: string;
let baseImagePath: string;
// 完整 provider 配置：deriveBridgedVisualModels 需 apiKeyConfigured + models[*].capabilities
// 才会派生条目（终审 M1 能力闸前置）。resolveBridgedEndpoint 已被 mock，但能力闸读真 settings。
// chat-model 仅 general，用于验证能力闸挡聊天桥接 id。
const settings = {
  models: {
    providers: {
      'custom-agnes-ai-free': {
        displayName: 'Agnes', baseUrl: 'https://apihub.agnes-ai.com/v1', apiKeyConfigured: true, enabled: true,
        models: {
          'agnes-video-v2.0': { capabilities: ['videoGen'], enabled: true },
          'chat-model': { capabilities: ['general'], enabled: true },
        },
      },
      sourceprov: {
        displayName: 'SourceProv', baseUrl: 'https://sp.example.com/v1', apiKeyConfigured: true, enabled: true,
        models: { 'vid-model': { capabilities: ['videoGen'], enabled: true } },
      },
    },
  },
} as never;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'design-video-ipc-'));
  cfg.root = workDir; // 设计根 = workDir/design
  designRoot = join(workDir, 'design');
  outputPath = join(designRoot, 'run', 'out', 'clip.mp4');
  baseImagePath = join(designRoot, 'run', 'base.png');
  await mkdir(join(designRoot, 'run'), { recursive: true });
  await writeFile(baseImagePath, Buffer.from('basepng'));
  vi.clearAllMocks();
  const reg = await import(VIDEO_REG);
  (reg.getCustomVideoModel as any).mockResolvedValue(null);
  (reg.getCustomVideoModelApiKey as any).mockReturnValue(undefined);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('桥接视频生成（provider:model → openai-compat）', () => {
  it('t2v 桥接 id 走 openai-compat 视频引擎 + 真落盘，不走内置 generateVideo', async () => {
    const svc = await import(VIDEO_SVC);
    const { handleGenerateDesignVideo } = await import('../../../src/host/ipc/workspaceDesignMedia.ipc');
    const res = await handleGenerateDesignVideo(
      { mode: 't2v', prompt: 'a cat', outputPath, model: 'custom-agnes-ai-free:agnes-video-v2.0' },
      () => settings,
    );
    expect(res.actualModel).toBe('agnes-video-v2.0');
    expect((svc.generateVideoOpenAICompat as any).mock.calls.length).toBe(1);
    expect((svc.generateVideoOpenAICompat as any).mock.calls[0][0]).toMatchObject({
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      apiKey: 'sk',
      modelName: 'agnes-video-v2.0',
      mode: 't2v',
      prompt: 'a cat',
    });
    expect((svc.generateVideo as any).mock.calls.length).toBe(0);
    const written = await readFile(outputPath);
    expect(written.toString()).toBe('mp4-bytes');
  });

  it('i2v 桥接 id 把画布底图读成 dataURL 透传，并落盘', async () => {
    const svc = await import(VIDEO_SVC);
    const { handleGenerateDesignVideo } = await import('../../../src/host/ipc/workspaceDesignMedia.ipc');
    const res = await handleGenerateDesignVideo(
      { mode: 'i2v', baseImagePath, outputPath, model: 'sourceprov:vid-model' },
      () => settings,
    );
    expect(res.actualModel).toBe('vid-model');
    const arg = (svc.generateVideoOpenAICompat as any).mock.calls[0][0];
    expect(arg.mode).toBe('i2v');
    expect(arg.imageDataUrl).toMatch(/^data:image\/png;base64,/);
    await readFile(outputPath); // 落盘存在
  });

  it('桥接 i2v 底图越界时抛错且不触发付费调用', async () => {
    const svc = await import(VIDEO_SVC);
    const { handleGenerateDesignVideo } = await import('../../../src/host/ipc/workspaceDesignMedia.ipc');
    await expect(
      handleGenerateDesignVideo(
        { mode: 'i2v', baseImagePath: '/etc/passwd', outputPath, model: 'sourceprov:vid-model' },
        () => settings,
      ),
    ).rejects.toThrow(/越界/);
    expect((svc.generateVideoOpenAICompat as any).mock.calls.length).toBe(0);
  });

  it('outputPath 越界时抛错且不触发付费调用', async () => {
    const svc = await import(VIDEO_SVC);
    const { handleGenerateDesignVideo } = await import('../../../src/host/ipc/workspaceDesignMedia.ipc');
    await expect(
      handleGenerateDesignVideo(
        { mode: 't2v', prompt: 'a cat', outputPath: '/tmp/evil.mp4', model: 'sourceprov:vid-model' },
        () => settings,
      ),
    ).rejects.toThrow(/越界/);
    expect((svc.generateVideoOpenAICompat as any).mock.calls.length).toBe(0);
  });

  // 终审 M1：含冒号但非视频生成能力的桥接 id（chat-model 仅 general）→ 被能力闸挡下，不付费出片。
  it('含冒号但非视频生成能力的桥接 id 抛错且零付费调用', async () => {
    const svc = await import(VIDEO_SVC);
    const { handleGenerateDesignVideo } = await import('../../../src/host/ipc/workspaceDesignMedia.ipc');
    await expect(
      handleGenerateDesignVideo(
        { mode: 't2v', prompt: 'a cat', outputPath, model: 'custom-agnes-ai-free:chat-model' },
        () => settings,
      ),
    ).rejects.toThrow(/未知或不支持的桥接视频模型/);
    expect((svc.generateVideoOpenAICompat as any).mock.calls.length).toBe(0);
  });
});

describe('custom 视频生成（注册表命中 → openai-compat，补完断链）', () => {
  it('custom id 命中走 generateVideoOpenAICompat + 真落盘', async () => {
    const reg = await import(VIDEO_REG);
    const svc = await import(VIDEO_SVC);
    (reg.getCustomVideoModel as any).mockResolvedValue({
      id: 'my-video',
      label: '我的视频模型',
      baseUrl: 'https://video.example.com/v1',
      modelName: 'cool-video-v1',
      createdAt: 0,
      updatedAt: 0,
    });
    (reg.getCustomVideoModelApiKey as any).mockReturnValue('ck');
    const { handleGenerateDesignVideo } = await import('../../../src/host/ipc/workspaceDesignMedia.ipc');
    const res = await handleGenerateDesignVideo(
      { mode: 't2v', prompt: 'a dog', outputPath, model: 'my-video' },
      () => settings,
    );
    expect(res.actualModel).toBe('cool-video-v1');
    const arg = (svc.generateVideoOpenAICompat as any).mock.calls[0][0];
    expect(arg).toMatchObject({
      baseUrl: 'https://video.example.com/v1',
      apiKey: 'ck',
      modelName: 'cool-video-v1',
    });
    expect((svc.generateVideo as any).mock.calls.length).toBe(0);
    const written = await readFile(outputPath);
    expect(written.toString()).toBe('mp4-bytes');
  });

  it('custom 命中但未配 key 时抛错且不触发付费调用', async () => {
    const reg = await import(VIDEO_REG);
    const svc = await import(VIDEO_SVC);
    (reg.getCustomVideoModel as any).mockResolvedValue({
      id: 'my-video',
      label: '我的视频模型',
      baseUrl: 'https://video.example.com/v1',
      modelName: 'cool-video-v1',
      createdAt: 0,
      updatedAt: 0,
    });
    (reg.getCustomVideoModelApiKey as any).mockReturnValue(undefined);
    const { handleGenerateDesignVideo } = await import('../../../src/host/ipc/workspaceDesignMedia.ipc');
    await expect(
      handleGenerateDesignVideo({ mode: 't2v', prompt: 'a dog', outputPath, model: 'my-video' }, () => settings),
    ).rejects.toThrow(/API Key/);
    expect((svc.generateVideoOpenAICompat as any).mock.calls.length).toBe(0);
  });
});
