// ============================================================================
// 多模态桥接 P4 · Task 16 — handleGenerateDesignMusic IPC handler + 落盘
//
// 内置 MiniMax 音乐（id: minimax-music-2.6 → 真实 model 名 music-2.6）直连出片，
// `provider:model` 桥接 id → resolveBridgedEndpoint 取源聊天 provider 端点。
// generateMusic 返回 audioBuffer（Buffer，非 url）→ 直接写盘，无下载步。
// 越界 outputPath / 空 prompt+lyrics 在付费 service 调用前拦下（paid no-op 守门）。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../src/host/services/media/musicGenerationService', () => ({
  generateMusic: vi.fn((a: { modelName: string; prompt?: string; lyrics?: string }) =>
    Promise.resolve({ audioBuffer: Buffer.from('mp3'), actualModel: a.modelName }),
  ),
}));

vi.mock('../../../src/host/services/media/imageGenerationService', () => ({
  getMinimaxApiKey: vi.fn(() => 'sk'),
}));

vi.mock('../../../src/host/services/media/bridgedEndpoint', () => ({
  resolveBridgedEndpoint: vi.fn(() => ({ baseUrl: 'https://bridge.example.com/v1', apiKey: 'bk' })),
}));

// 设计目录根可变 mock：让 handler 的 assertWithinDesignDir 越界守卫以 <cfg.root>/design 为边界。
const cfg = vi.hoisted(() => ({ root: '' }));
vi.mock('../../../src/host/config/configPaths', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/host/config/configPaths')>();
  return { ...actual, getUserConfigDir: () => cfg.root };
});

const MUSIC_SVC = '../../../src/host/services/media/musicGenerationService';
const IMG_SVC = '../../../src/host/services/media/imageGenerationService';
const BRIDGE = '../../../src/host/services/media/bridgedEndpoint';

let workDir: string;
let designRoot: string;
let outputPath: string;
const settings = { providers: {} } as never; // resolveBridgedEndpoint 已被 mock，settings 内容不参与

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'design-music-ipc-'));
  cfg.root = workDir; // 设计根 = workDir/design
  designRoot = join(workDir, 'design');
  outputPath = join(designRoot, 'run', 'm.mp3');
  await mkdir(join(designRoot, 'run'), { recursive: true });
  vi.clearAllMocks();
  const img = await import(IMG_SVC);
  (img.getMinimaxApiKey as any).mockReturnValue('sk');
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('handleGenerateDesignMusic', () => {
  it('内置 minimax 音乐：写 audioBuffer 落盘 + 返回 actualModel/costCny', async () => {
    const svc = await import(MUSIC_SVC);
    const { handleGenerateDesignMusic } = await import('../../../src/host/ipc/workspaceDesignMedia.ipc');
    const res = await handleGenerateDesignMusic(
      { prompt: 'pop', outputPath, model: 'minimax-music-2.6' },
      () => null,
    );
    // id minimax-music-2.6 映射到真实 model 名 music-2.6
    expect(res.actualModel).toBe('music-2.6');
    expect(typeof res.costCny).toBe('number');
    expect(res.costCny).toBeGreaterThan(0);
    const arg = (svc.generateMusic as any).mock.calls[0][0];
    expect(arg).toMatchObject({
      baseUrl: expect.any(String),
      apiKey: 'sk',
      modelName: 'music-2.6',
      prompt: 'pop',
    });
    const written = await readFile(outputPath);
    expect(written.toString()).toBe('mp3'); // 直接落 audioBuffer，无下载步
  });

  it('桥接音乐：provider:model 走 resolveBridgedEndpoint', async () => {
    const svc = await import(MUSIC_SVC);
    const bridge = await import(BRIDGE);
    const { handleGenerateDesignMusic } = await import('../../../src/host/ipc/workspaceDesignMedia.ipc');
    const res = await handleGenerateDesignMusic(
      { prompt: 'jazz', outputPath, model: 'custom-x:some-music' },
      () => settings,
    );
    expect(res.actualModel).toBe('some-music');
    expect((bridge.resolveBridgedEndpoint as any).mock.calls[0][0]).toBe('custom-x');
    const arg = (svc.generateMusic as any).mock.calls[0][0];
    expect(arg).toMatchObject({
      baseUrl: 'https://bridge.example.com/v1',
      apiKey: 'bk',
      modelName: 'some-music',
    });
    await readFile(outputPath); // 落盘存在
  });

  it('越界 outputPath 抛错不出片', async () => {
    const svc = await import(MUSIC_SVC);
    const { handleGenerateDesignMusic } = await import('../../../src/host/ipc/workspaceDesignMedia.ipc');
    await expect(
      handleGenerateDesignMusic({ prompt: 'pop', outputPath: '/etc/evil.mp3', model: 'minimax-music-2.6' }, () => null),
    ).rejects.toThrow(/越界/);
    expect((svc.generateMusic as any).mock.calls.length).toBe(0);
  });

  it('空 prompt 且空 lyrics 抛错（付费前置）', async () => {
    const svc = await import(MUSIC_SVC);
    const { handleGenerateDesignMusic } = await import('../../../src/host/ipc/workspaceDesignMedia.ipc');
    await expect(
      handleGenerateDesignMusic({ prompt: '  ', lyrics: '', outputPath, model: 'minimax-music-2.6' }, () => null),
    ).rejects.toThrow();
    expect((svc.generateMusic as any).mock.calls.length).toBe(0);
  });
});
