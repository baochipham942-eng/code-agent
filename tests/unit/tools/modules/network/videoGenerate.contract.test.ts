// ============================================================================
// video_generate contract tests — N-MEDIA-GEN-PHASE2
//
// 对齐 image 合同（mirror imageGenerate.contract.test.ts）：output_file_path 工作区相对、
// 越界/旧参数/坏 image_path/缺 key 在任何付费调用与写盘之前 INVALID_ARGS；MiniMax 海螺
// 默认路由（generateVideo + downloadVideoAsBuffer 全 mock，fetch 从未被真实调用）；
// 1/1 saved + per_request；output 与 meta 不出现远端 URL（虚拟产物 metadata 例外）。
// ============================================================================

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/host/protocol/tools';
import { collectToolArtifactsFromMetadata } from '../../../../../src/shared/contract/artifactBlob';

const videoService = vi.hoisted(() => ({
  generateVideo: vi.fn(),
  downloadVideoAsBuffer: vi.fn(),
}));

const imageService = vi.hoisted(() => ({
  getMinimaxApiKey: vi.fn(),
}));

// fs 走「真实透传 + 记录 + 可注入写失败」的模块级 mock：vi.spyOn 拦不到外部化 node 内建
// 模块在 handler 侧的绑定，模块 mock 才能拦到（仓内 videoGenerate.test.ts 同款范式）。
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

vi.mock('../../../../../src/host/services/media/videoGenerationService', () => videoService);
vi.mock('../../../../../src/host/services/media/imageGenerationService', () => imageService);

import { executeVideoGenerate } from '../../../../../src/host/plugins/builtin/videoGeneration/videoGenerate';
import { videoGenerateSchema } from '../../../../../src/host/plugins/builtin/videoGeneration/videoGenerate.schema';

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

const REMOTE_URL = 'https://cdn.example/generated-video.mp4';

describe('video_generate contract (MiniMax default route)', () => {
  let workspace: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'video-generate-contract-'));
    fsMock.writeFileSyncCalls.mockReset();
    fsMock.writeFileSyncFails = false;
    imageService.getMinimaxApiKey.mockReset().mockReturnValue('test-minimax-key');
    videoService.generateVideo.mockReset()
      .mockResolvedValue({ url: REMOTE_URL, actualModel: 'MiniMax-Hailuo-02', durationSec: 6 });
    videoService.downloadVideoAsBuffer.mockReset()
      .mockResolvedValue(Buffer.from('mock-mp4-body'));
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    fs.rmSync(workspace, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('exposes the contract schema without a union type or legacy output_path', () => {
    const properties = videoGenerateSchema.inputSchema.properties as Record<string, { type?: string }>;
    expect(properties.output_file_path?.type).toBe('string');
    expect(properties.output_path).toBeUndefined();
    expect(properties.model?.type).toBe('string');
    expect(properties.image_path?.type).toBe('string');
    for (const property of Object.values(properties)) {
      expect(Array.isArray(property.type), JSON.stringify(property)).toBe(false);
    }
  });

  it('refuses invalid args before any service, fetch, write, or briefing call', async () => {
    const textFile = path.join(workspace, 'notes.txt');
    const oversized = path.join(workspace, 'large.png');
    fs.writeFileSync(textFile, 'text');
    fs.writeFileSync(oversized, Buffer.alloc(10 * 1024 * 1024 + 1));
    fsMock.writeFileSyncCalls.mockClear();

    const cases: Array<{ args: Record<string, unknown>; match: RegExp }> = [
      { args: { prompt: 'ok', output_path: 'old.mp4' }, match: /renamed to output_file_path/ },
      { args: { prompt: 'ok', output_file_path: '../outside.mp4' }, match: /inside the workspace/ },
      { args: { prompt: 'ok', image_path: '/tmp/outside.png' }, match: /inside the workspace/ },
      { args: { prompt: 'ok', image_path: 'missing.png' }, match: /does not exist/ },
      { args: { prompt: 'ok', image_path: 'notes.txt' }, match: /png, jpg, jpeg, or webp/ },
      { args: { prompt: 'ok', image_path: 'large.png' }, match: /10 MB limit/ },
      { args: { prompt: 'ok', image_url: 'https://cdn.example/start.png' }, match: /only valid with cogvideox/ },
      { args: { prompt: 'ok', model: 'cogvideox-2', image_path: 'notes.txt' }, match: /only supported on MiniMax/ },
    ];
    for (const { args, match } of cases) {
      const emit = vi.fn();
      const result = await executeVideoGenerate(args, ctx(workspace, new AbortController(), emit), allow);
      expect(result.ok, JSON.stringify(args)).toBe(false);
      if (!result.ok) {
        expect(result.code, JSON.stringify(args)).toBe('INVALID_ARGS');
        expect(result.error).toMatch(match);
      }
      expect(videoService.generateVideo, JSON.stringify(args)).not.toHaveBeenCalled();
      expect(fetchSpy, JSON.stringify(args)).not.toHaveBeenCalled();
      expect(fsMock.writeFileSyncCalls, JSON.stringify(args)).not.toHaveBeenCalled();
      expect(emit, JSON.stringify(args)).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(workspace, '.code-agent')), JSON.stringify(args)).toBe(false);
    }
  });

  it('refuses a missing MiniMax key before any paid call or write', async () => {
    imageService.getMinimaxApiKey.mockReturnValue(undefined);
    const emit = vi.fn();
    const result = await executeVideoGenerate(
      { prompt: 'ok' },
      ctx(workspace, new AbortController(), emit),
      allow,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('MiniMax API key is missing');
    }
    expect(videoService.generateVideo).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fsMock.writeFileSyncCalls).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('saves via generateVideo + downloadVideoAsBuffer and reports 1/1 saved without any URL', async () => {
    const controller = new AbortController();
    const result = await executeVideoGenerate(
      { prompt: '海面日出延时', output_file_path: 'videos/out.mp4' },
      ctx(workspace, controller),
      allow,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(videoService.generateVideo).toHaveBeenCalledTimes(1);
    expect(videoService.generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      model: 'MiniMax-Hailuo-02',
      mode: 't2v',
      prompt: '海面日出延时',
      outerSignal: controller.signal,
    }));
    expect(videoService.downloadVideoAsBuffer).toHaveBeenCalledWith(REMOTE_URL, controller.signal);

    expect(result.output).toMatch(/^1\/1 saved\nper_request /);
    expect(result.output).not.toContain('https://');
    const perRequest = result.meta?.per_request as Array<Record<string, unknown>>;
    expect(perRequest).toEqual([
      { index: 1, status: 'saved', bytes: 'mock-mp4-body'.length, path: 'videos/out.mp4' },
    ]);
    expect(collectToolArtifactsFromMetadata(result.meta)).toHaveLength(1);
    expect(collectToolArtifactsFromMetadata(result.meta)[0]).toMatchObject({
      kind: 'video',
      path: path.join(workspace, 'videos/out.mp4'),
    });
    expect(fs.existsSync(path.join(workspace, 'videos/out.mp4'))).toBe(true);
    // 合同：meta 里任何位置不出现远端 URL（含 Hailuo 下载地址）
    expect(JSON.stringify(result.meta)).not.toContain('https://');
    expect(JSON.stringify(result.meta)).not.toContain('http://');
    expect(result.meta?.videoPath).toBe(path.join(workspace, 'videos/out.mp4'));
    expect(result.meta?.outputPath).toBe(path.join(workspace, 'videos/out.mp4'));
    expect(result.meta?.mediaKind).toBe('video');
  });

  it('routes image_path to the I2V-01 model as an image data URL', async () => {
    fs.writeFileSync(path.join(workspace, 'ref.png'), 'reference-bytes');
    const result = await executeVideoGenerate(
      { prompt: '让画面动起来', image_path: 'ref.png' },
      ctx(workspace),
      allow,
    );
    expect(result.ok).toBe(true);
    expect(videoService.generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      model: 'I2V-01',
      mode: 'i2v',
      imageDataUrl: `data:image/png;base64,${Buffer.from('reference-bytes').toString('base64')}`,
    }));
  });

  it('reports 0/1 saved with the engine error verbatim and ok consistent with per_request', async () => {
    videoService.generateVideo.mockRejectedValue(new Error('海螺视频任务失败: content filtered'));
    const result = await executeVideoGenerate({ prompt: '违规内容' }, ctx(workspace), allow);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VIDEO_GENERATION_FAILED');
      expect(result.error).toMatch(/^0\/1 saved\nper_request /);
      expect(result.error).toContain('海螺视频任务失败: content filtered');
    }
    const perRequest = result.meta?.per_request as Array<Record<string, unknown>>;
    expect(perRequest).toEqual([{ index: 1, status: 'failed', error: '海螺视频任务失败: content filtered' }]);
    expect(videoService.generateVideo).toHaveBeenCalledTimes(1);
    expect(videoService.downloadVideoAsBuffer).not.toHaveBeenCalled();
  });

  it('records a failed request without leaking the URL when the download fails', async () => {
    videoService.downloadVideoAsBuffer.mockRejectedValue(new Error('download unavailable'));
    const result = await executeVideoGenerate({ prompt: 'ok' }, ctx(workspace), allow);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/^0\/1 saved\nper_request /);
      expect(result.error).toContain('video was generated but could not be saved');
      expect(result.error).not.toContain(REMOTE_URL);
      expect(result.error).not.toContain('https://');
    }
    const perRequest = result.meta?.per_request as Array<Record<string, unknown>>;
    expect(perRequest).toEqual([{ index: 1, status: 'failed', error: 'video was generated but could not be saved' }]);
    // 远端 URL 只允许出现在虚拟产物 metadata（image 合同同款例外）
    const artifacts = collectToolArtifactsFromMetadata(result.meta);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      kind: 'video',
      url: undefined,
      metadata: { generated: true, url: REMOTE_URL },
    });
    const { artifacts: _removed, ...metaWithoutArtifacts } = result.meta as Record<string, unknown>;
    expect(JSON.stringify(metaWithoutArtifacts)).not.toContain('https://');
    expect(fs.readdirSync(workspace)).toEqual([]);
  });

  it('reports the same save-failure shape when the disk write fails', async () => {
    fsMock.writeFileSyncFails = true;
    const result = await executeVideoGenerate({ prompt: 'ok' }, ctx(workspace), allow);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/^0\/1 saved\nper_request /);
      expect(result.error).toContain('video was generated but could not be saved');
    }
  });

  it('does not write to disk when generation resolves after an abort', async () => {
    const controller = new AbortController();
    videoService.generateVideo.mockImplementation(async () => {
      controller.abort();
      return { url: REMOTE_URL, actualModel: 'MiniMax-Hailuo-02', durationSec: 6 };
    });
    const result = await executeVideoGenerate({ prompt: 'abort me' }, ctx(workspace, controller), allow);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ABORTED');
    expect(videoService.downloadVideoAsBuffer).not.toHaveBeenCalled();
    expect(fsMock.writeFileSyncCalls).not.toHaveBeenCalled();
    expect(fs.readdirSync(workspace)).toEqual([]);
  });
});
