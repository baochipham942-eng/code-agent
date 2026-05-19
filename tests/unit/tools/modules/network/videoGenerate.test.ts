// ============================================================================
// video_generate (native ToolModule) Tests — P1 Wave 4 D2c
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

const { existsSyncMock, mkdirSyncMock, writeFileSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn().mockReturnValue(true),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
  mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
  writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
}));

const { getConfigServiceMock } = vi.hoisted(() => ({
  getConfigServiceMock: vi.fn(),
}));

vi.mock('../../../../../src/main/services', () => ({
  getConfigService: () => getConfigServiceMock(),
}));

import { videoGenerateModule, executeVideoGenerate } from '../../../../../src/main/plugins/builtin/videoGeneration/videoGenerate';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: '/tmp/work',
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

describe('video_generate — schema', () => {
  it('declares correct name and category', () => {
    expect(videoGenerateModule.schema.name).toBe('video_generate');
    expect(videoGenerateModule.schema.category).toBe('network');
    expect(videoGenerateModule.schema.permissionLevel).toBe('network');
  });

  it('requires prompt', () => {
    expect(videoGenerateModule.schema.inputSchema.required).toEqual(['prompt']);
  });
});

describe('video_generate — execute', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
    process.env.ZHIPU_OFFICIAL_API_KEY = 'official-key';
    getConfigServiceMock.mockReturnValue({
      getApiKey: vi.fn().mockReturnValue(undefined),
    });
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('happy path: submit + immediate SUCCESS without download', async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // prompt expansion
        return Promise.resolve({
          ok: true,
          json: async () => ({ choices: [{ message: { content: '扩展后的描述' } }] }),
        });
      }
      if (callCount === 2) {
        // submit
        return Promise.resolve({ ok: true, json: async () => ({ id: 'task-abc' }) });
      }
      // poll → SUCCESS
      return Promise.resolve({
        ok: true,
        json: async () => ({
          id: 'task-abc',
          model: 'cogvideox-2',
          task_status: 'SUCCESS',
          video_result: [{ url: 'https://cdn/video.mp4', cover_image_url: 'https://cdn/cover.jpg' }],
        }),
      });
    });

    const result = await executeVideoGenerate(
      { prompt: '一只猫' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta?.videoUrl).toBe('https://cdn/video.mp4');
      expect(result.meta?.coverUrl).toBe('https://cdn/cover.jpg');
      expect(result.meta?.aspectRatio).toBe('16:9');
      expect(result.meta?.artifact).toMatchObject({
        kind: 'video',
        sourceTool: 'video_generate',
        url: 'https://cdn/video.mp4',
        mimeType: 'video/mp4',
        metadata: {
          taskId: 'task-abc',
          mediaKind: 'video',
          duration: 5,
          fps: 30,
        },
      });
      expect(result.meta?.mediaKind).toBe('video');
      expect(result.meta?.contentLength).toBe(result.output.length);
      expect(result.meta?.truncated).toBe(false);
    }
  });

  it('downloads video when output_path given', async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ choices: [{ message: { content: '描述' } }] }),
        });
      }
      if (callCount === 2) {
        return Promise.resolve({ ok: true, json: async () => ({ id: 't1' }) });
      }
      if (callCount === 3) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            task_status: 'SUCCESS',
            video_result: [{ url: 'https://cdn/v.mp4', cover_image_url: 'https://cdn/c.jpg' }],
          }),
        });
      }
      // download
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      });
    });

    const result = await executeVideoGenerate(
      { prompt: 'test', output_path: '/tmp/work/video.mp4' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    expect(writeFileSyncMock).toHaveBeenCalled();
    if (result.ok) {
      expect(result.meta?.videoPath).toBe('/tmp/work/video.mp4');
      expect(result.meta?.artifact).toMatchObject({
        kind: 'video',
        sourceTool: 'video_generate',
        path: '/tmp/work/video.mp4',
        mimeType: 'video/mp4',
        metadata: {
          taskId: 't1',
          mediaKind: 'video',
        },
      });
      expect(result.meta?.outputPath).toBe('/tmp/work/video.mp4');
    }
  });

  it('returns FAIL message from API', async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: 'p' } }] }) });
      if (callCount === 2) return Promise.resolve({ ok: true, json: async () => ({ id: 't' }) });
      return Promise.resolve({
        ok: true,
        json: async () => ({
          task_status: 'FAIL',
          error: { code: 'ERR_X', message: '内容违规' },
        }),
      });
    });

    const result = await executeVideoGenerate(
      { prompt: '违规' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('视频生成失败');
      expect(result.error).toContain('内容违规');
    }
  });

  it('rejects when canUseTool denies', async () => {
    const result = await executeVideoGenerate(
      { prompt: 'cat' },
      makeCtx(),
      async () => ({ allow: false, reason: 'no perm' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PERMISSION_DENIED');
    }
  });

  it('rejects pre-aborted signal', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await executeVideoGenerate(
      { prompt: 'cat' },
      makeCtx({ abortSignal: ctrl.signal }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ABORTED');
    }
  });

  it('rejects missing prompt', async () => {
    const result = await executeVideoGenerate({}, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
    }
  });

  it('returns NOT_INITIALIZED when no zhipu key', async () => {
    delete process.env.ZHIPU_OFFICIAL_API_KEY;
    getConfigServiceMock.mockReturnValue({
      getApiKey: vi.fn().mockReturnValue(undefined),
    });
    const result = await executeVideoGenerate(
      { prompt: 'cat' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_INITIALIZED');
    }
  });

  it('rejects 0ki proxy key (only official)', async () => {
    delete process.env.ZHIPU_OFFICIAL_API_KEY;
    getConfigServiceMock.mockReturnValue({
      getApiKey: vi.fn().mockReturnValue('oki-proxy-key'),
    });
    const result = await executeVideoGenerate(
      { prompt: 'cat' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_INITIALIZED');
    }
  });

  it('uses 9:16 size for vertical', async () => {
    const submitBodies: Record<string, unknown>[] = [];
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation((_url, opts) => {
      callCount++;
      if (callCount === 1) return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: 'p' } }] }) });
      if (callCount === 2) {
        submitBodies.push(JSON.parse((opts as RequestInit).body as string) as Record<string, unknown>);
        return Promise.resolve({ ok: true, json: async () => ({ id: 't' }) });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          task_status: 'SUCCESS',
          video_result: [{ url: 'u', cover_image_url: 'c' }],
        }),
      });
    });

    await executeVideoGenerate(
      { prompt: 'vertical', aspect_ratio: '9:16' },
      makeCtx(),
      allowAll,
    );

    expect(submitBodies.length).toBe(1);
    expect(submitBodies[0].size).toBe('1080x1920');
  });

  it('emits onProgress', async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: 'p' } }] }) });
      if (callCount === 2) return Promise.resolve({ ok: true, json: async () => ({ id: 't' }) });
      return Promise.resolve({
        ok: true,
        json: async () => ({
          task_status: 'SUCCESS',
          video_result: [{ url: 'u', cover_image_url: 'c' }],
        }),
      });
    });
    const onProgress = vi.fn();
    await executeVideoGenerate(
      { prompt: 'cat' },
      makeCtx(),
      allowAll,
      onProgress,
    );
    expect(onProgress).toHaveBeenCalledWith({ stage: 'starting', detail: 'video_generate' });
    expect(onProgress).toHaveBeenCalledWith({ stage: 'completing', percent: 100 });
  });
});
