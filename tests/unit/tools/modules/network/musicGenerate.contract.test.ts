// ============================================================================
// music_generate contract tests — N-MEDIA-GEN-PHASE2
//
// 对齐 image 合同：output_file_path 工作区相对、越界/旧参数/缺 key 在任何付费调用与写盘
// 之前 INVALID_ARGS；generateMusic 全 mock（fetch 从未被真实调用）；1/1 saved + per_request；
// 非零 base_resp 的原始报错如实进 error 且不重试；保留旧 meta 键（outputPath/audioPath/costCny）。
// ============================================================================

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/host/protocol/tools';
import { collectToolArtifactsFromMetadata } from '../../../../../src/shared/contract/artifactBlob';

const musicService = vi.hoisted(() => ({
  generateMusic: vi.fn(),
  resolveMusicModelEndpoint: vi.fn(),
}));

const imageService = vi.hoisted(() => ({
  getMinimaxApiKey: vi.fn(),
}));

// fs 走「真实透传 + 记录 + 可注入写失败」的模块级 mock（同 videoGenerate.contract.test.ts）。
const fsMock = vi.hoisted(() => ({
  writeFileSyncCalls: vi.fn(),
  writeFileSyncFails: false,
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) => {
      fsMock.writeFileSyncCalls(...args);
      if (fsMock.writeFileSyncFails) throw new Error('EACCES: mock write failure');
      return actual.writeFileSync(...args);
    }) as typeof actual.writeFileSync,
  };
});

vi.mock('../../../../../src/host/services/media/musicGenerationService', () => musicService);
vi.mock('../../../../../src/host/services/media/imageGenerationService', () => imageService);

import { executeMusicGenerate } from '../../../../../src/host/plugins/builtin/musicGeneration/musicGenerate';
import { musicGenerateSchema } from '../../../../../src/host/plugins/builtin/musicGeneration/musicGenerate.schema';

function logger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function ctx(workspace: string, controller = new AbortController(), emit = vi.fn()): ToolContext {
  return {
    sessionId: 'contract-test',
    workingDir: workspace,
    abortSignal: controller.signal,
    logger: logger(),
    emit,
  } as unknown as ToolContext;
}

const allow: CanUseToolFn = async () => ({ allow: true });

describe('music_generate contract', () => {
  let workspace: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'music-generate-contract-'));
    fsMock.writeFileSyncCalls.mockReset();
    fsMock.writeFileSyncFails = false;
    imageService.getMinimaxApiKey.mockReset().mockReturnValue('test-minimax-key');
    musicService.resolveMusicModelEndpoint.mockReset().mockReturnValue({
      baseUrl: 'https://api.minimax.chat/v1',
      apiKey: 'sk',
      modelName: 'music-2.6',
    });
    musicService.generateMusic.mockReset().mockResolvedValue({
      audioBuffer: Buffer.from('mock-mp3-body'),
      actualModel: 'music-2.6',
    });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    fs.rmSync(workspace, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('exposes the contract schema without a union type or legacy output_path', () => {
    const properties = musicGenerateSchema.inputSchema.properties as Record<string, { type?: string }>;
    expect(properties.output_file_path?.type).toBe('string');
    expect(properties.output_path).toBeUndefined();
    for (const property of Object.values(properties)) {
      expect(Array.isArray(property.type), JSON.stringify(property)).toBe(false);
    }
    expect(musicGenerateSchema.permissionLevel).toBe('network');
    expect(musicGenerateSchema.description).toContain('$0.15');
  });

  it('refuses invalid args before any service, fetch, write, or briefing call', async () => {
    const cases: Array<{ args: Record<string, unknown>; match: RegExp }> = [
      { args: { prompt: 'ok', output_path: 'old.mp3' }, match: /renamed to output_file_path/ },
      { args: { prompt: 'ok', output_file_path: '../outside.mp3' }, match: /inside the workspace/ },
      { args: { prompt: 'ok', output_file_path: '/tmp/outside-song.mp3' }, match: /inside the workspace/ },
    ];
    for (const { args, match } of cases) {
      const emit = vi.fn();
      const result = await executeMusicGenerate(args, ctx(workspace, new AbortController(), emit), allow);
      expect(result.ok, JSON.stringify(args)).toBe(false);
      if (!result.ok) {
        expect(result.code, JSON.stringify(args)).toBe('INVALID_ARGS');
        expect(result.error).toMatch(match);
      }
      expect(musicService.generateMusic, JSON.stringify(args)).not.toHaveBeenCalled();
      expect(fetchSpy, JSON.stringify(args)).not.toHaveBeenCalled();
      expect(fsMock.writeFileSyncCalls, JSON.stringify(args)).not.toHaveBeenCalled();
      expect(emit, JSON.stringify(args)).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(workspace, '.code-agent')), JSON.stringify(args)).toBe(false);
    }
  });

  it('refuses a missing MiniMax key before any paid call or write', async () => {
    imageService.getMinimaxApiKey.mockReturnValue(undefined);
    const emit = vi.fn();
    const result = await executeMusicGenerate(
      { prompt: 'ok' },
      ctx(workspace, new AbortController(), emit),
      allow,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('MiniMax API key is missing');
    }
    expect(musicService.resolveMusicModelEndpoint).not.toHaveBeenCalled();
    expect(musicService.generateMusic).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fsMock.writeFileSyncCalls).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('saves the track and reports 1/1 saved with the legacy meta keys', async () => {
    const result = await executeMusicGenerate(
      { prompt: '轻快的钢琴背景音乐', output_file_path: 'music/track.mp3' },
      ctx(workspace),
      allow,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.output).toMatch(/^1\/1 saved\nper_request /);
    expect(result.output).not.toContain('https://');
    const perRequest = result.meta?.per_request as Array<Record<string, unknown>>;
    expect(perRequest).toEqual([
      { index: 1, status: 'saved', bytes: 'mock-mp3-body'.length, path: 'music/track.mp3' },
    ]);
    const artifacts = collectToolArtifactsFromMetadata(result.meta);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      kind: 'audio',
      path: path.join(workspace, 'music/track.mp3'),
    });
    expect(fs.existsSync(path.join(workspace, 'music/track.mp3'))).toBe(true);
    // 旧 meta 键保留：现有读取方（sessionMediaAssets / ToolDetails / status rail）不受影响
    expect(result.meta).toMatchObject({
      outputPath: path.join(workspace, 'music/track.mp3'),
      audioPath: path.join(workspace, 'music/track.mp3'),
      mediaKind: 'audio',
      model: 'music-2.6',
    });
    expect(typeof result.meta?.costCny).toBe('number');
    expect(JSON.stringify(result.meta)).not.toContain('https://');
  });

  it('carries a non-zero base_resp message into the failed request without retry', async () => {
    musicService.generateMusic.mockRejectedValue(
      new Error('音乐生成失败：音乐 API 已对新用户关闭，无法调用'),
    );
    const result = await executeMusicGenerate({ prompt: '一首短曲' }, ctx(workspace), allow);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('MUSIC_GENERATION_FAILED');
      expect(result.error).toMatch(/^0\/1 saved\nper_request /);
      expect(result.error).toContain('音乐生成失败：音乐 API 已对新用户关闭，无法调用');
    }
    const perRequest = result.meta?.per_request as Array<Record<string, unknown>>;
    expect(perRequest).toEqual([
      { index: 1, status: 'failed', error: '音乐生成失败：音乐 API 已对新用户关闭，无法调用' },
    ]);
    // 不重试：引擎恰好一次
    expect(musicService.generateMusic).toHaveBeenCalledTimes(1);
    expect(fsMock.writeFileSyncCalls).not.toHaveBeenCalled();
  });

  it('reports the save-failure shape when the disk write fails', async () => {
    fsMock.writeFileSyncFails = true;
    const result = await executeMusicGenerate({ prompt: 'ok' }, ctx(workspace), allow);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/^0\/1 saved\nper_request /);
      expect(result.error).toContain('music was generated but could not be saved');
    }
    expect(musicService.generateMusic).toHaveBeenCalledTimes(1);
  });

  it('does not write to disk when generation resolves after an abort', async () => {
    const controller = new AbortController();
    musicService.generateMusic.mockImplementation(async () => {
      controller.abort();
      return { audioBuffer: Buffer.from('late'), actualModel: 'music-2.6' };
    });
    const result = await executeMusicGenerate({ prompt: 'abort me' }, ctx(workspace, controller), allow);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ABORTED');
    expect(fsMock.writeFileSyncCalls).not.toHaveBeenCalled();
  });
});
