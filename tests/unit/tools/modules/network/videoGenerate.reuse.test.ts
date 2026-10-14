// ============================================================================
// video_generate 复用账本（N-MEDIA-GEN-VIDEO-IDEMPOTENT）
// ============================================================================
// 承重不变量：崩溃恢复 / 自动重试重发相同参数时，已落盘的视频被复用（MiniMax
// generateVideo / downloadVideoAsBuffer 零调用、不再计费）；而模型已看到结果的
// "再来一条"照常出新视频。判定规则与 imageGenerateReuse.ts 相同：(a) 文件仍在且
// 大小一致，(b) 产出那次调用没有把 success/error complete 送达循环（recovered 不算），
// (c) 路径在工作区内。指纹含请求模型、image_path 内容哈希、aspect_ratio / quality /
// duration / fps；未传的 output_file_path（时间戳默认路径）不进指纹。

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolContext, CanUseToolFn, Logger, ToolProgressFn } from '../../../../../src/host/protocol/tools';

const videoService = vi.hoisted(() => ({
  generateVideo: vi.fn(),
  downloadVideoAsBuffer: vi.fn(),
}));

const imageService = vi.hoisted(() => ({
  getMinimaxApiKey: vi.fn(),
}));

const db = vi.hoisted(() => ({
  getToolExecutionsBySession: vi.fn(() => [] as unknown[]),
  getToolExecutionsBySessionAndToolCallId: vi.fn((_sessionId: string, _toolCallId: string) => [] as unknown[]),
}));

vi.mock('../../../../../src/host/services/media/videoGenerationService', () => videoService);
vi.mock('../../../../../src/host/services/media/imageGenerationService', () => imageService);
vi.mock('../../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => db,
}));

import { executeVideoGenerate } from '../../../../../src/host/plugins/builtin/videoGeneration/videoGenerate';

const REUSE_LINE = '复用上次生成结果 (reused previous result, no new charge)';
const VIDEO_BYTES = 'mock-mp4-body';
const REMOTE_URL = 'https://cdn.example/generated-video.mp4';
const ACTUAL_MODEL = 'recorded-video-model';
const SESSION_ID = 'video-reuse-session';

function logger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function ctx(workspace: string, toolCallId: string, emit = vi.fn()): ToolContext {
  return {
    sessionId: SESSION_ID,
    workingDir: workspace,
    abortSignal: new AbortController().signal,
    logger: logger(),
    emit,
    currentToolCallId: toolCallId,
  } as unknown as ToolContext;
}

const allow: CanUseToolFn = async () => ({ allow: true });

function setExecutionEvents(
  events: Array<{ executionId: string; toolCallId?: string | null; phase: string; status?: string | null }>,
): void {
  db.getToolExecutionsBySession.mockReturnValue(events);
  db.getToolExecutionsBySessionAndToolCallId.mockImplementation(
    (_sessionId: string, toolCallId: string) => {
      const executionIds = new Set(
        events
          .filter((event) => event.phase === 'begin' && event.toolCallId === toolCallId)
          .map((event) => event.executionId),
      );
      return events.filter((event) => executionIds.has(event.executionId));
    },
  );
}

describe('video_generate 复用账本', () => {
  let workspace: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  function run(
    args: Record<string, unknown>,
    toolCallId: string,
    hooks?: { emit?: ReturnType<typeof vi.fn>; onProgress?: ToolProgressFn },
  ) {
    return executeVideoGenerate(args, ctx(workspace, toolCallId, hooks?.emit), allow, hooks?.onProgress);
  }

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'video-generate-reuse-'));
    imageService.getMinimaxApiKey.mockReset().mockReturnValue('test-minimax-key');
    videoService.generateVideo.mockReset().mockResolvedValue({
      url: REMOTE_URL,
      actualModel: ACTUAL_MODEL,
      durationSec: 6,
    });
    videoService.downloadVideoAsBuffer.mockReset().mockResolvedValue(Buffer.from(VIDEO_BYTES));
    db.getToolExecutionsBySession.mockReset().mockReturnValue([]);
    db.getToolExecutionsBySessionAndToolCallId.mockReset().mockReturnValue([]);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    fs.rmSync(workspace, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function expectNoReuse(label: string, firstArgs: Record<string, unknown>, secondArgs: Record<string, unknown>): Promise<void> {
    const before = videoService.generateVideo.mock.calls.length;
    const id = `param-${label}`;
    expect((await run(firstArgs, id)).ok, label).toBe(true);
    const second = await run(secondArgs, id);
    expect(second.ok, label).toBe(true);
    expect(videoService.generateVideo.mock.calls.length - before, label).toBe(2);
    if (!second.ok) return;
    expect(second.output, label).not.toContain(REUSE_LINE);
    expect(second.meta?.reused, label).toBeUndefined();
  }

  it('①崩溃重放（同 toolCallId）：复用已落盘视频，generateVideo 零调用', async () => {
    const args = { prompt: '一只猫在跑' };
    const first = await run(args, 'call-crash');
    expect(first.ok).toBe(true);
    expect(videoService.generateVideo).toHaveBeenCalledTimes(1);
    expect(videoService.downloadVideoAsBuffer).toHaveBeenCalledTimes(1);
    if (!first.ok) return;
    const savedPath = first.meta?.videoPath as string;
    expect(fs.existsSync(savedPath)).toBe(true);
    expect(fs.readFileSync(savedPath).toString()).toBe(VIDEO_BYTES);

    setExecutionEvents([
      { executionId: 'exec-1', toolCallId: 'call-crash', phase: 'begin' },
      { executionId: 'exec-1', phase: 'complete', status: 'recovered' },
    ]);
    videoService.generateVideo.mockClear();
    videoService.downloadVideoAsBuffer.mockClear();
    const emit = vi.fn();
    const onProgress = vi.fn();

    const replay = await run(args, 'call-crash', { emit, onProgress });
    expect(replay.ok).toBe(true);
    expect(videoService.generateVideo).not.toHaveBeenCalled();
    expect(videoService.downloadVideoAsBuffer).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    if (!replay.ok) return;
    expect(replay.output.split('\n')[0]).toBe('1/1 saved');
    expect(replay.output).toContain(REUSE_LINE);
    expect(replay.meta?.reused).toBe(true);
    expect(replay.meta?.model).toBe(ACTUAL_MODEL);
    expect(replay.meta?.videoPath).toBe(savedPath);
    expect(replay.meta?.outputPath).toBe(savedPath);
    const perRequest = replay.meta?.per_request as Array<Record<string, unknown>>;
    expect(perRequest[0]).toMatchObject({
      index: 1,
      status: 'saved',
      bytes: VIDEO_BYTES.length,
      reused: true,
    });
    expect(replay.meta?.artifact).toMatchObject({
      kind: 'video',
      sourceTool: 'video_generate',
      path: savedPath,
      metadata: { reused: true, model: ACTUAL_MODEL },
    });
    expect(JSON.stringify(replay.meta)).not.toContain(REMOTE_URL);
  });

  it('①新 toolCallId 且无已送达 complete（自动重试）：复用同一路径，零额外 MiniMax 调用', async () => {
    const args = { prompt: '海面日出延时' };
    const first = await run(args, 'call-A');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const savedPath = first.meta?.videoPath as string;
    expect(typeof savedPath).toBe('string');
    expect(fs.existsSync(savedPath)).toBe(true);

    setExecutionEvents([{ executionId: 'exec-1', toolCallId: 'call-A', phase: 'begin' }]);
    videoService.generateVideo.mockClear();
    videoService.downloadVideoAsBuffer.mockClear();

    const retry = await run(args, 'call-B');
    expect(retry.ok).toBe(true);
    expect(videoService.generateVideo).not.toHaveBeenCalled();
    expect(videoService.downloadVideoAsBuffer).not.toHaveBeenCalled();
    if (!retry.ok) return;
    expect(retry.output.split('\n')[0]).toBe('1/1 saved');
    expect(retry.output).toContain(REUSE_LINE);
    expect(retry.meta?.reused).toBe(true);
    expect(retry.meta?.videoPath).toBe(savedPath);
    expect((retry.meta?.per_request as Array<{ reused?: boolean }>)[0].reused).toBe(true);
    expect(retry.meta?.artifact).toMatchObject({
      metadata: { reused: true, model: ACTUAL_MODEL },
    });
  });

  it('①recovered 收口不算已送达：新 toolCallId 的重试仍复用', async () => {
    const args = { prompt: 'recovered-retry' };
    const first = await run(args, 'call-A');
    expect(first.ok).toBe(true);
    setExecutionEvents([
      { executionId: 'exec-1', toolCallId: 'call-A', phase: 'begin' },
      { executionId: 'exec-1', phase: 'complete', status: 'recovered' },
    ]);
    videoService.generateVideo.mockClear();

    const retry = await run(args, 'call-B');
    expect(retry.ok).toBe(true);
    expect(videoService.generateVideo).not.toHaveBeenCalled();
    if (!retry.ok || !first.ok) return;
    expect(retry.meta?.videoPath).toBe(first.meta?.videoPath);
    expect(retry.output).toContain(REUSE_LINE);
  });

  it('①参考图内容变了：不复用，重新生成', async () => {
    fs.writeFileSync(path.join(workspace, 'ref.png'), 'frame-v1');
    const args = { prompt: '让这张图动起来', image_path: 'ref.png' };
    expect((await run(args, 'call-img')).ok).toBe(true);
    expect(videoService.generateVideo).toHaveBeenCalledTimes(1);

    fs.writeFileSync(path.join(workspace, 'ref.png'), 'frame-v2-different-bytes');
    videoService.generateVideo.mockClear();
    const second = await run(args, 'call-img');
    expect(second.ok).toBe(true);
    expect(videoService.generateVideo).toHaveBeenCalledTimes(1);
    if (!second.ok) return;
    expect(second.output).not.toContain(REUSE_LINE);
    expect(second.meta?.reused).toBeUndefined();
  });

  it('①模型变了：不复用，重新生成', async () => {
    await expectNoReuse(
      'model',
      { prompt: '同一句描述', model: 'MiniMax-Hailuo-02' },
      { prompt: '同一句描述', model: 'other-video-model' },
    );
  });

  it('①时长变了：不复用，重新生成', async () => {
    await expectNoReuse(
      'duration',
      { prompt: '同一句描述', duration: 5 },
      { prompt: '同一句描述', duration: 10 },
    );
  });

  it('①aspect_ratio / quality / fps 任一变化都不复用', async () => {
    await expectNoReuse(
      'aspect',
      { prompt: '比例', aspect_ratio: '16:9' },
      { prompt: '比例', aspect_ratio: '9:16' },
    );
    await expectNoReuse(
      'quality',
      { prompt: '质量', quality: 'quality' },
      { prompt: '质量', quality: 'speed' },
    );
    await expectNoReuse(
      'fps',
      { prompt: '帧率', fps: 30 },
      { prompt: '帧率', fps: 60 },
    );
  });

  it('①产物被截断（大小与记账不一致）：不复用，重新生成', async () => {
    const args = { prompt: '截断测试', output_file_path: 'videos/out.mp4' };
    expect((await run(args, 'call-trunc')).ok).toBe(true);
    const savedPath = path.join(workspace, 'videos/out.mp4');
    const original = fs.readFileSync(savedPath);
    fs.writeFileSync(savedPath, original.subarray(0, original.length - 4));
    expect(fs.statSync(savedPath).size).not.toBe(original.length);

    videoService.generateVideo.mockClear();
    const replay = await run(args, 'call-trunc');
    expect(replay.ok).toBe(true);
    expect(videoService.generateVideo).toHaveBeenCalledTimes(1);
    if (!replay.ok) return;
    expect(replay.output).not.toContain(REUSE_LINE);
    expect(replay.meta?.reused).toBeUndefined();
  });

  it('①账本指向工作区外：不复用，不把外部文件登记成产物', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-generate-outside-'));
    try {
      const secret = path.join(outsideDir, 'secret.mp4');
      fs.writeFileSync(secret, Buffer.from('secret-video-bytes'));
      const args = { prompt: '工作区外账目', output_file_path: 'videos/out.mp4' };
      const first = await run(args, 'call-A');
      expect(first.ok).toBe(true);
      expect(videoService.generateVideo).toHaveBeenCalledTimes(1);

      const ledgerPath = path.join(workspace, '.code-agent', 'artifacts', 'videos', 'generation-ledger.json');
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as {
        entries: Array<{ saved: Array<{ absolutePath: string; bytes: number }> }>;
      };
      ledger.entries[0].saved[0].absolutePath = secret;
      ledger.entries[0].saved[0].bytes = fs.statSync(secret).size;
      fs.writeFileSync(ledgerPath, JSON.stringify(ledger));

      videoService.generateVideo.mockClear();
      const replay = await run(args, 'call-A');
      expect(replay.ok).toBe(true);
      expect(videoService.generateVideo).toHaveBeenCalledTimes(1);
      if (!replay.ok) return;
      expect(replay.output).not.toContain(REUSE_LINE);
      expect(replay.meta?.reused).toBeUndefined();
      expect(replay.meta?.videoPath).not.toBe(secret);
      expect(JSON.stringify(replay.meta?.artifact)).not.toContain(secret);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('②上次调用已 success complete：再来一条照常生成，新路径，generateVideo 调用一次', async () => {
    const args = { prompt: '再来一条' };
    const first = await run(args, 'call-A');
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    setExecutionEvents([
      { executionId: 'exec-1', toolCallId: 'call-A', phase: 'begin' },
      { executionId: 'exec-1', phase: 'complete', status: 'success' },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    videoService.generateVideo.mockClear();
    videoService.downloadVideoAsBuffer.mockClear();

    const another = await run(args, 'call-B');
    expect(another.ok).toBe(true);
    expect(videoService.generateVideo).toHaveBeenCalledTimes(1);
    expect(videoService.downloadVideoAsBuffer).toHaveBeenCalledTimes(1);
    if (!another.ok) return;
    expect(another.output).not.toContain(REUSE_LINE);
    expect(another.meta?.reused).toBeUndefined();
    expect((another.meta?.per_request as Array<{ reused?: boolean }>)[0].reused).toBeUndefined();
    expect(another.meta?.videoPath).not.toBe(first.meta?.videoPath);
    expect(fs.existsSync(another.meta?.videoPath as string)).toBe(true);
    expect(fs.existsSync(first.meta?.videoPath as string)).toBe(true);
  });

  it('②复用后账目归属改到本次 toolCallId：该次送达后再来一条照常生成', async () => {
    const args = { prompt: '归属转移' };
    const first = await run(args, 'call-A');
    expect(first.ok).toBe(true);
    setExecutionEvents([{ executionId: 'exec-1', toolCallId: 'call-A', phase: 'begin' }]);
    videoService.generateVideo.mockClear();

    const reused = await run(args, 'call-B');
    expect(reused.ok).toBe(true);
    expect(videoService.generateVideo).not.toHaveBeenCalled();
    if (!reused.ok || !first.ok) return;
    expect(reused.meta?.videoPath).toBe(first.meta?.videoPath);

    setExecutionEvents([
      { executionId: 'exec-2', toolCallId: 'call-B', phase: 'begin' },
      { executionId: 'exec-2', phase: 'complete', status: 'success' },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    videoService.generateVideo.mockClear();

    const another = await run(args, 'call-C');
    expect(another.ok).toBe(true);
    expect(videoService.generateVideo).toHaveBeenCalledTimes(1);
    if (!another.ok) return;
    expect(another.output).not.toContain(REUSE_LINE);
    expect(another.meta?.videoPath).not.toBe(first.meta?.videoPath);
  });
});
