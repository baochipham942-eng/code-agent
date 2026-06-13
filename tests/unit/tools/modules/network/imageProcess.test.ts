// ============================================================================
// image_process (native ToolModule) Tests — P1 Wave 4 D2c
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

const { existsSyncMock, mkdirSyncMock, statSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn().mockReturnValue(true),
  mkdirSyncMock: vi.fn(),
  statSyncMock: vi.fn().mockReturnValue({ size: 4096 }),
}));

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
  mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
  statSync: (...args: unknown[]) => statSyncMock(...args),
}));

const { sharpFactoryMock, sharpInstanceMock, toFileMock, metadataMock } = vi.hoisted(() => {
  const toFileMock = vi.fn().mockResolvedValue({ size: 1024 });
  const metadataMock = vi.fn().mockResolvedValue({ width: 800, height: 600 });
  const sharpInstance = {
    metadata: metadataMock,
    resize: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    webp: vi.fn().mockReturnThis(),
    avif: vi.fn().mockReturnThis(),
    gif: vi.fn().mockReturnThis(),
    toFile: toFileMock,
  };
  const sharpFactoryMock = vi.fn(() => sharpInstance);
  Object.assign(sharpFactoryMock, { kernel: { lanczos3: 'lanczos3' } });
  return {
    sharpFactoryMock,
    sharpInstanceMock: sharpInstance,
    toFileMock,
    metadataMock,
  };
});

vi.mock('../../../../../src/main/runtime/sharpRuntime', () => {
  return {
    requireSharp: () => sharpFactoryMock,
  };
});

import { imageProcessModule, executeImageProcess } from '../../../../../src/main/plugins/builtin/imageProcess/imageProcess';

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

describe('image_process — schema', () => {
  it('declares correct name and category', () => {
    expect(imageProcessModule.schema.name).toBe('image_process');
    expect(imageProcessModule.schema.category).toBe('network');
    expect(imageProcessModule.schema.permissionLevel).toBe('write');
  });

  it('requires action and can fallback input_path from current image attachments', () => {
    expect(imageProcessModule.schema.inputSchema.required).toEqual(['action']);
  });

  it('declares 4 actions', () => {
    const actionField = (imageProcessModule.schema.inputSchema.properties as Record<string, { enum?: string[] }>).action;
    expect(actionField.enum).toEqual(['convert', 'compress', 'resize', 'upscale']);
  });
});

describe('image_process — execute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockReturnValue({ size: 4096 });
    metadataMock.mockResolvedValue({ width: 800, height: 600 });
    toFileMock.mockResolvedValue({ size: 1024 });
  });

  it('happy path convert returns metadata', async () => {
    const result = await executeImageProcess(
      { input_path: '/abs/photo.png', action: 'convert', format: 'webp' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta?.artifact).toMatchObject({
        kind: 'image',
        sourceTool: 'image_process',
        path: '/tmp/work/photo_convert.webp',
        mimeType: 'image/webp',
        sizeBytes: 4096,
        metadata: {
          action: 'convert',
          inputPath: '/abs/photo.png',
          originalSize: 4096,
          width: 800,
          height: 600,
          format: 'webp',
          mediaLifecycle: {
            kind: 'edited-image',
            operation: 'convert',
            ownerSessionId: 'test-session',
            sourceImages: ['/abs/photo.png'],
            fallbackStrategy: 'source-and-output-paths-retained',
          },
        },
      });
      expect(result.meta?.format).toBe('webp');
      expect(result.meta?.action).toBe('convert');
      expect((result.meta?.attachment as Record<string, unknown>)?.category).toBe('image');
      expect((result.meta?.attachment as Record<string, unknown>)?.mimeType).toBe('image/webp');
    }
  });

  it('falls back to the current image attachment when input_path is omitted', async () => {
    const result = await executeImageProcess(
      { action: 'compress', quality: 70 },
      makeCtx({
        subagent: {
          attachments: [
            { type: 'file', path: '/abs/readme.txt', mimeType: 'text/plain' },
            { type: 'image', path: '/abs/fallback.png', mimeType: 'image/png' },
          ],
        },
      }),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta?.artifact).toMatchObject({
        path: '/tmp/work/fallback_compress.png',
        metadata: {
          inputPath: '/abs/fallback.png',
          mediaLifecycle: {
            kind: 'edited-image',
            operation: 'compress',
            ownerSessionId: 'test-session',
            sourceImages: ['/abs/fallback.png'],
            fallbackStrategy: 'current-image-attachment',
            fallbackUsed: true,
          },
        },
      });
    }
  });

  it('returns a short failure when image_process has no input image', async () => {
    const result = await executeImageProcess(
      { action: 'compress' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toBe('缺少输入图片路径。请提供 input_path，或先在当前消息附加一张图片。');
      expect(result.meta).toMatchObject({
        mediaLifecycle: {
          kind: 'edited-image',
          state: 'failed',
          fallbackStrategy: 'current-image-attachment',
          fallbackReason: 'no-input-image',
        },
      });
    }
  });

  it('compress action with quality', async () => {
    const result = await executeImageProcess(
      { input_path: '/abs/photo.jpg', action: 'compress', quality: 60 },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    expect(sharpInstanceMock.jpeg).toHaveBeenCalledWith({ quality: 60, mozjpeg: true });
  });

  it('resize action with dimensions', async () => {
    const result = await executeImageProcess(
      { input_path: '/abs/photo.png', action: 'resize', width: 400, height: 300 },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    expect(sharpInstanceMock.resize).toHaveBeenCalledWith(400, 300, expect.objectContaining({ fit: 'inside' }));
  });

  it('upscale action uses lanczos kernel', async () => {
    const result = await executeImageProcess(
      { input_path: '/abs/photo.png', action: 'upscale', scale: 3 },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    expect(sharpInstanceMock.resize).toHaveBeenCalledWith(2400, 1800, { kernel: 'lanczos3' });
  });

  it('rejects when canUseTool denies', async () => {
    const result = await executeImageProcess(
      { input_path: '/abs/p.png', action: 'compress' },
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
    const result = await executeImageProcess(
      { input_path: '/abs/p.png', action: 'compress' },
      makeCtx({ abortSignal: ctrl.signal }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ABORTED');
    }
  });

  it('rejects missing input_path', async () => {
    const result = await executeImageProcess(
      { action: 'compress' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
    }
  });

  it('rejects invalid action', async () => {
    const result = await executeImageProcess(
      { input_path: '/abs/p.png', action: 'rotate' },
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
    const result = await executeImageProcess(
      { input_path: '/abs/missing.png', action: 'compress' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('FS_ERROR');
    }
  });

  it('rejects unsupported input format', async () => {
    const result = await executeImageProcess(
      { input_path: '/abs/file.exe', action: 'compress' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('不支持的输入格式');
    }
  });

  it('rejects convert without format', async () => {
    const result = await executeImageProcess(
      { input_path: '/abs/p.png', action: 'convert' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('format');
    }
  });

  it('rejects resize without dimensions', async () => {
    const result = await executeImageProcess(
      { input_path: '/abs/p.png', action: 'resize' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('width');
    }
  });

  it('emits onProgress', async () => {
    const onProgress = vi.fn();
    await executeImageProcess(
      { input_path: '/abs/p.png', action: 'compress' },
      makeCtx(),
      allowAll,
      onProgress,
    );
    expect(onProgress).toHaveBeenCalledWith({ stage: 'starting', detail: 'image_process' });
    expect(onProgress).toHaveBeenCalledWith({ stage: 'completing', percent: 100 });
  });
});
