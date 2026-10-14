// ============================================================================
// video_generate (native ToolModule) Tests — P1 Wave 4 D2c
// ============================================================================
// N-MEDIA-GEN-PHASE2：默认路由改为 MiniMax 海螺（见 videoGenerate.contract.test.ts），
// 本文件钉死 cogvideox-* 旧路径行为：提交→轮询→下载落盘（不再返回 URL）。
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/host/protocol/tools';

const { existsSyncMock, mkdirSyncMock, writeFileSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn().mockReturnValue(true),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
}));

// workspaceScope.ts reads realpathSync/lstatSync/readlinkSync/statSync from node:fs.
// A partial fs mock makes isPathWithinRoot fail closed and would refuse in-workspace paths.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: (...args: unknown[]) => existsSyncMock(...args),
    mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
    writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
  };
});

const { getConfigServiceMock } = vi.hoisted(() => ({
  getConfigServiceMock: vi.fn(),
}));

vi.mock('../../../../../src/host/services', () => ({
  getConfigService: () => getConfigServiceMock(),
}));

// 智谱官方视频 key 查找已抽到 toolAvailability（直连 core/configService，不走 barrel），
// 两条路径都要 mock 到，handler 与可用性判定读到同一份 fake config。
vi.mock('../../../../../src/host/services/core/configService', () => ({
  getConfigService: () => getConfigServiceMock(),
}));

import { videoGenerateModule, executeVideoGenerate } from '../../../../../src/host/plugins/builtin/videoGeneration/videoGenerate';

function jsonChatCompletion(content: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function sseChatCompletion(content: string): Response {
  const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`,
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  return new Response(sse, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

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

/** cogvideox 提交→立即 SUCCESS→下载 的四段 fetch 序列（扩写 / 提交 / 轮询 / 下载）。 */
function zhipuFetchSequence(opts: { expanded?: string; videoUrl?: string } = {}) {
  let callCount = 0;
  global.fetch = vi.fn().mockImplementation(() => {
    callCount++;
    if (callCount === 1) {
      // prompt expansion
      return Promise.resolve(jsonChatCompletion(opts.expanded ?? '扩展后的描述'));
    }
    if (callCount === 2) {
      // submit
      return Promise.resolve({ ok: true, json: async () => ({ id: 'task-abc' }) });
    }
    if (callCount === 3) {
      // poll → SUCCESS
      return Promise.resolve({
        ok: true,
        json: async () => ({
          id: 'task-abc',
          model: 'cogvideox-2',
          task_status: 'SUCCESS',
          video_result: [{ url: opts.videoUrl ?? 'https://cdn/video.mp4', cover_image_url: 'https://cdn/cover.jpg' }],
        }),
      });
    }
    // download
    return Promise.resolve({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
  });
  return global.fetch as ReturnType<typeof vi.fn>;
}

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
    getConfigServiceMock.mockReturnValue({ onSettingsUpdated: vi.fn(),
      getApiKey: vi.fn().mockReturnValue(undefined),
    });
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('happy path: submit + immediate SUCCESS, downloaded and saved (no URL in meta)', async () => {
    zhipuFetchSequence();

    const result = await executeVideoGenerate(
      { prompt: '一只猫', model: 'cogvideox-2' },
      makeCtx(),
      allowAll,
    );

    // 提示词扩写打的是智谱官方端点：model 必须是官方端点上存在的免费快模型，
    // 不能复用已切 0ki 专属 glm-5.3-flash 的 DEFAULT_MODELS.quick（否则 model not found → 静默回落短提示词）
    const [expandUrl, expandInit] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(expandUrl).toContain('open.bigmodel.cn');
    expect(JSON.parse(String(expandInit.body)).model).toBe('glm-4-flash');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toMatch(/^1\/1 saved\nper_request /);
      expect(result.meta?.model).toBe('cogvideox-2');
      expect(typeof result.meta?.videoPath).toBe('string');
      expect(result.meta?.videoPath).toMatch(/^\/tmp\/work\/\.code-agent\/artifacts\/videos\/generated-.*\.mp4$/);
      expect(result.meta?.outputPath).toBe(result.meta?.videoPath);
      expect(result.meta?.artifact).toMatchObject({
        kind: 'video',
        sourceTool: 'video_generate',
        path: result.meta?.videoPath,
        mimeType: 'video/mp4',
        metadata: {
          taskId: 'task-abc',
          mediaKind: 'video',
          duration: 5,
          fps: 30,
        },
      });
      expect(result.meta?.mediaKind).toBe('video');
      // 旧路径也不再把远端 URL 写进 meta（N-MEDIA-GEN-PHASE2 合同）
      expect(result.meta?.videoUrl).toBeUndefined();
      expect(result.meta?.coverUrl).toBeUndefined();
      expect(JSON.stringify(result.meta)).not.toContain('https://cdn');
    }
    expect(writeFileSyncMock).toHaveBeenCalled();
  });

  it('downloads video when output_file_path given', async () => {
    zhipuFetchSequence();

    const result = await executeVideoGenerate(
      { prompt: 'test', model: 'cogvideox-2', output_file_path: 'video.mp4' },
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
          taskId: 'task-abc',
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
      if (callCount === 1) return Promise.resolve(jsonChatCompletion('p'));
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
      { prompt: '违规', model: 'cogvideox-2' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/^0\/1 saved\nper_request /);
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

  it('refuses legacy output_path with INVALID_ARGS before any call', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const result = await executeVideoGenerate(
      { prompt: 'cat', model: 'cogvideox-2', output_path: '/tmp/work/video.mp4' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('renamed to output_file_path');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns NOT_INITIALIZED when no zhipu key', async () => {
    delete process.env.ZHIPU_OFFICIAL_API_KEY;
    getConfigServiceMock.mockReturnValue({ onSettingsUpdated: vi.fn(),
      getApiKey: vi.fn().mockReturnValue(undefined),
    });
    const result = await executeVideoGenerate(
      { prompt: 'cat', model: 'cogvideox-2' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_INITIALIZED');
      expect(result.error).toContain('video_generate');
      expect(result.error).toContain('视频生成模型配置');
      expect(result.error).toContain('当前版本可识别的配置');
      expect(result.error).toContain('ZHIPU_OFFICIAL_API_KEY');
    }
  });

  it('rejects 0ki proxy key (only official)', async () => {
    delete process.env.ZHIPU_OFFICIAL_API_KEY;
    getConfigServiceMock.mockReturnValue({ onSettingsUpdated: vi.fn(),
      getApiKey: vi.fn().mockReturnValue('oki-proxy-key'),
    });
    const result = await executeVideoGenerate(
      { prompt: 'cat', model: 'cogvideox-2' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_INITIALIZED');
      expect(result.error).toContain('0ki/普通智谱代理不支持这个视频生成接口');
    }
  });

  it('uses 9:16 size for vertical', async () => {
    const submitBodies: Record<string, unknown>[] = [];
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation((_url, opts) => {
      callCount++;
      if (callCount === 1) return Promise.resolve(jsonChatCompletion('p'));
      if (callCount === 2) {
        submitBodies.push(JSON.parse((opts as RequestInit).body as string) as Record<string, unknown>);
        return Promise.resolve({ ok: true, json: async () => ({ id: 't' }) });
      }
      if (callCount === 3) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            task_status: 'SUCCESS',
            video_result: [{ url: 'u', cover_image_url: 'c' }],
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      });
    });

    await executeVideoGenerate(
      { prompt: 'vertical', model: 'cogvideox-2', aspect_ratio: '9:16' },
      makeCtx(),
      allowAll,
    );

    expect(submitBodies.length).toBe(1);
    expect(submitBodies[0].size).toBe('1080x1920');
  });

  it('emits onProgress', async () => {
    zhipuFetchSequence();
    const onProgress = vi.fn();
    await executeVideoGenerate(
      { prompt: 'cat', model: 'cogvideox-2' },
      makeCtx(),
      allowAll,
      onProgress,
    );
    expect(onProgress).toHaveBeenCalledWith({ stage: 'starting', detail: 'video_generate' });
    expect(onProgress).toHaveBeenCalledWith({ stage: 'completing', percent: 100 });
  });

  it('sniffs SSE expand into the submit prompt, not a JSON.parse exception', async () => {
    const submitBodies: Record<string, unknown>[] = [];
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation((_url, opts) => {
      callCount++;
      if (callCount === 1) return Promise.resolve(sseChatCompletion('SSE扩写后的视频描述'));
      if (callCount === 2) {
        submitBodies.push(JSON.parse((opts as RequestInit).body as string) as Record<string, unknown>);
        return Promise.resolve({ ok: true, json: async () => ({ id: 'task-sse' }) });
      }
      if (callCount === 3) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            task_status: 'SUCCESS',
            video_result: [{ url: 'https://cdn/video.mp4', cover_image_url: 'https://cdn/cover.jpg' }],
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      });
    });

    const result = await executeVideoGenerate({ prompt: '一只猫', model: 'cogvideox-2' }, makeCtx(), allowAll);
    expect(result.ok).toBe(true);
    expect(submitBodies[0]?.prompt).toBe('SSE扩写后的视频描述');
  });

  it('malformed SSE expand falls back to the original prompt and leaves a structured warn', async () => {
    const logger = makeLogger();
    const submitBodies: Record<string, unknown>[] = [];
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation((_url, opts) => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(new Response('data: not-json\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }));
      }
      if (callCount === 2) {
        submitBodies.push(JSON.parse((opts as RequestInit).body as string) as Record<string, unknown>);
        return Promise.resolve({ ok: true, json: async () => ({ id: 'task-fb' }) });
      }
      if (callCount === 3) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            task_status: 'SUCCESS',
            video_result: [{ url: 'https://cdn/video.mp4', cover_image_url: 'https://cdn/cover.jpg' }],
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      });
    });

    const result = await executeVideoGenerate(
      { prompt: '一只猫', model: 'cogvideox-2' },
      makeCtx({ logger }),
      allowAll,
    );
    expect(result.ok).toBe(true);
    expect(submitBodies[0]?.prompt).toBe('一只猫');
    expect(logger.warn).toHaveBeenCalledWith(
      'video_generate prompt expand failed',
      expect.objectContaining({ reason: 'malformed SSE data' }),
    );
    const warnPayload = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === 'video_generate prompt expand failed',
    )?.[1] as { reason?: string; error?: string };
    expect(warnPayload?.error).toBeUndefined();
    expect(String(warnPayload?.reason)).not.toMatch(/Unexpected token/);
  });
});
