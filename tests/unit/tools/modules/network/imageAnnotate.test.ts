// ============================================================================
// image_annotate (native ToolModule) Tests — P1 Wave 4 D2c
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

const { existsSyncMock, statSyncMock, readFileSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn().mockReturnValue(true),
  statSyncMock: vi.fn().mockReturnValue({ size: 1024 * 100 }),
  readFileSyncMock: vi.fn().mockReturnValue(Buffer.from('img-data')),
}));

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
  statSync: (...args: unknown[]) => statSyncMock(...args),
  readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
}));

const { sharpFactoryMock, sharpInstanceMock, toFileMock, metadataMock, compositeMock } = vi.hoisted(() => {
  const toFileMock = vi.fn().mockResolvedValue({ size: 2048 });
  const metadataMock = vi.fn().mockResolvedValue({ width: 1024, height: 768 });
  const compositeMock = vi.fn();
  const sharpInstance: Record<string, unknown> = {
    metadata: metadataMock,
    composite: compositeMock,
    toFile: toFileMock,
  };
  compositeMock.mockReturnValue(sharpInstance);
  return {
    sharpFactoryMock: vi.fn(() => sharpInstance),
    sharpInstanceMock: sharpInstance,
    toFileMock,
    metadataMock,
    compositeMock,
  };
});

vi.mock('../../../../../src/main/runtime/sharpRuntime', () => ({
  requireSharp: () => sharpFactoryMock,
}));

const { getConfigServiceMock } = vi.hoisted(() => ({
  getConfigServiceMock: vi.fn(),
}));

vi.mock('../../../../../src/main/services', () => ({
  getConfigService: () => getConfigServiceMock(),
}));

import { imageAnnotateModule, executeImageAnnotate } from '../../../../../src/main/plugins/builtin/imageCreation/imageAnnotate';

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

describe('image_annotate — schema', () => {
  it('declares correct name and category', () => {
    expect(imageAnnotateModule.schema.name).toBe('image_annotate');
    expect(imageAnnotateModule.schema.category).toBe('network');
    expect(imageAnnotateModule.schema.permissionLevel).toBe('write');
  });

  it('requires image_path and query', () => {
    expect(imageAnnotateModule.schema.inputSchema.required).toEqual(['image_path', 'query']);
  });
});

describe('image_annotate — execute', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockReturnValue({ size: 1024 * 100 });
    metadataMock.mockResolvedValue({ width: 1024, height: 768 });
    toFileMock.mockResolvedValue({ size: 2048 });
    compositeMock.mockReturnValue(sharpInstanceMock);
    getConfigServiceMock.mockReturnValue({
      getApiKey: vi.fn().mockReturnValue(undefined),
    });
    delete process.env.BAIDU_OCR_API_KEY;
    delete process.env.BAIDU_OCR_SECRET_KEY;
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('happy path: baidu OCR draws rectangles', async () => {
    process.env.BAIDU_OCR_API_KEY = 'baidu-key';
    process.env.BAIDU_OCR_SECRET_KEY = 'baidu-secret';

    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // baidu token endpoint
        return Promise.resolve({
          ok: true,
          json: async () => ({ access_token: 'test-token' }),
        });
      }
      // baidu OCR endpoint
      return Promise.resolve({
        ok: true,
        json: async () => ({
          words_result: [
            { words: '你好', location: { left: 10, top: 20, width: 100, height: 30 }, probability: { average: 0.95 } },
            { words: '世界', location: { left: 120, top: 20, width: 100, height: 30 } },
          ],
        }),
      });
    });

    const result = await executeImageAnnotate(
      { image_path: '/abs/p.png', query: '框出文字' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta?.ocrMethod).toBe('baidu');
      expect((result.meta?.regions as unknown[])?.length).toBe(2);
      expect((result.meta?.attachment as Record<string, unknown>)?.category).toBe('image');
      expect(result.meta?.artifact).toMatchObject({
        kind: 'image',
        sourceTool: 'image_annotate',
        metadata: {
          imagePath: '/abs/p.png',
          query: '框出文字',
          ocrMethod: 'baidu',
          regionCount: 2,
          mediaKind: 'image',
          mediaLifecycle: {
            kind: 'annotated-image',
            operation: 'annotate',
            ownerSessionId: 'test-session',
            sourceImages: ['/abs/p.png'],
            fallbackStrategy: 'baidu-ocr-to-vision-llm',
            fallbackUsed: false,
          },
        },
      });
      expect(result.meta?.mediaKind).toBe('image');
      expect(result.meta?.outputPath).toBe(result.meta?.annotatedPath);
      expect(result.meta?.truncated).toBe(false);
    }
    expect(toFileMock).toHaveBeenCalled();
  });

  it('falls back to vision_llm when baidu not configured but zhipu present', async () => {
    getConfigServiceMock.mockReturnValue({
      getApiKey: vi.fn().mockReturnValue('zhipu-key'),
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '这是一段中文截图' } }],
      }),
    });

    const result = await executeImageAnnotate(
      { image_path: '/abs/p.png', query: '描述图片' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta?.ocrMethod).toBe('vision_llm');
      expect(result.output).toContain('图片内容分析');
      expect(result.output).toContain('BAIDU_OCR_API_KEY');
      expect(result.meta?.artifact).toMatchObject({
        kind: 'text',
        sourceTool: 'image_annotate',
        metadata: {
          imagePath: '/abs/p.png',
          query: '描述图片',
          ocrMethod: 'vision_llm',
          mediaKind: 'image',
          mediaLifecycle: {
            kind: 'image-analysis',
            operation: 'annotate',
            ownerSessionId: 'test-session',
            sourceImages: ['/abs/p.png'],
            fallbackStrategy: 'baidu-ocr-to-vision-llm',
            fallbackUsed: true,
            fallbackReason: 'baidu-ocr-unavailable-or-failed',
          },
        },
      });
      expect(result.meta?.contentLength).toBe('这是一段中文截图'.length);
    }
    expect(toFileMock).not.toHaveBeenCalled();
  });

  it('returns NOT_INITIALIZED when neither baidu nor zhipu configured', async () => {
    const result = await executeImageAnnotate(
      { image_path: '/abs/p.png', query: 'q' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_INITIALIZED');
      expect(result.error).toContain('OCR API');
    }
  });

  it('falls back to vision_llm when baidu OCR fails', async () => {
    process.env.BAIDU_OCR_API_KEY = 'baidu-key';
    process.env.BAIDU_OCR_SECRET_KEY = 'baidu-secret';
    getConfigServiceMock.mockReturnValue({
      getApiKey: vi.fn().mockReturnValue('zhipu-key'),
    });

    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      // zhipu vision call
      return Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '降级描述' } }] }),
      });
    });

    const result = await executeImageAnnotate(
      { image_path: '/abs/p.png', query: 'q' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta?.ocrMethod).toBe('vision_llm');
    }
  });

  it('rejects when canUseTool denies', async () => {
    const result = await executeImageAnnotate(
      { image_path: '/abs/p.png', query: 'q' },
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
    const result = await executeImageAnnotate(
      { image_path: '/abs/p.png', query: 'q' },
      makeCtx({ abortSignal: ctrl.signal }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ABORTED');
    }
  });

  it('rejects missing image_path', async () => {
    const result = await executeImageAnnotate(
      { query: 'q' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
    }
  });

  it('rejects missing query', async () => {
    const result = await executeImageAnnotate(
      { image_path: '/abs/p.png' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
    }
  });

  it('rejects non-existent file', async () => {
    existsSyncMock.mockReturnValueOnce(false);
    const result = await executeImageAnnotate(
      { image_path: '/abs/missing.png', query: 'q' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('FS_ERROR');
    }
  });

  it('rejects unsupported format', async () => {
    const result = await executeImageAnnotate(
      { image_path: '/abs/file.svg', query: 'q' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('不支持的图片格式');
    }
  });

  it('rejects oversize image', async () => {
    statSyncMock.mockReturnValue({ size: 20 * 1024 * 1024 });
    const result = await executeImageAnnotate(
      { image_path: '/abs/p.png', query: 'q' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('文件过大');
    }
  });

  it('emits onProgress', async () => {
    process.env.BAIDU_OCR_API_KEY = 'baidu-key';
    process.env.BAIDU_OCR_SECRET_KEY = 'baidu-secret';
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ ok: true, json: async () => ({ access_token: 't' }) });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          words_result: [{ words: 'A', location: { left: 0, top: 0, width: 50, height: 30 } }],
        }),
      });
    });
    const onProgress = vi.fn();
    await executeImageAnnotate(
      { image_path: '/abs/p.png', query: 'q' },
      makeCtx(),
      allowAll,
      onProgress,
    );
    expect(onProgress).toHaveBeenCalledWith({ stage: 'starting', detail: 'image_annotate' });
    expect(onProgress).toHaveBeenCalledWith({ stage: 'completing', percent: 100 });
  });
});
