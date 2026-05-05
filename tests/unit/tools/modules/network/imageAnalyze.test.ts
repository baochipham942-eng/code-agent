// ============================================================================
// image_analyze (native ToolModule) Tests — P1 Wave 4 D2c
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

const { accessMock, statMock, readFileMock } = vi.hoisted(() => ({
  accessMock: vi.fn().mockResolvedValue(undefined),
  statMock: vi.fn().mockResolvedValue({ size: 1024 * 100 }),
  readFileMock: vi.fn().mockResolvedValue(Buffer.from('img-data')),
}));

vi.mock('fs/promises', () => ({
  default: {
    access: (...args: unknown[]) => accessMock(...args),
    stat: (...args: unknown[]) => statMock(...args),
    readFile: (...args: unknown[]) => readFileMock(...args),
  },
  access: (...args: unknown[]) => accessMock(...args),
  stat: (...args: unknown[]) => statMock(...args),
  readFile: (...args: unknown[]) => readFileMock(...args),
}));

const { globMock } = vi.hoisted(() => ({
  globMock: vi.fn(),
}));

vi.mock('glob', () => ({
  glob: (...args: unknown[]) => globMock(...args),
}));

const { getConfigServiceMock } = vi.hoisted(() => ({
  getConfigServiceMock: vi.fn(),
}));

vi.mock('../../../../../src/main/services', () => ({
  getConfigService: () => getConfigServiceMock(),
}));

import { imageAnalyzeModule, executeImageAnalyze } from '../../../../../src/main/tools/modules/network/imageAnalyze';

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

describe('image_analyze — schema', () => {
  it('declares correct name and category', () => {
    expect(imageAnalyzeModule.schema.name).toBe('image_analyze');
    expect(imageAnalyzeModule.schema.category).toBe('network');
    expect(imageAnalyzeModule.schema.permissionLevel).toBe('network');
    expect(imageAnalyzeModule.schema.readOnly).toBe(true);
  });

  it('has no required fields (mode determined by params)', () => {
    expect(imageAnalyzeModule.schema.inputSchema.required).toBeUndefined();
  });
});

describe('image_analyze — execute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessMock.mockResolvedValue(undefined);
    statMock.mockResolvedValue({ size: 1024 * 100 });
    readFileMock.mockResolvedValue(Buffer.from('img-data'));
    getConfigServiceMock.mockReturnValue({
      getApiKey: vi.fn().mockReturnValue('test-zhipu-key'),
    });
  });

  it('happy path single mode via zhipu', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '一只橘猫' } }] }),
    });

    const result = await executeImageAnalyze(
      { path: '/abs/cat.png', prompt: '描述图片' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('一只橘猫');
      expect(result.meta?.path).toBe('/abs/cat.png');
    }
  });

  it('batch mode glob expansion + filter', async () => {
    globMock.mockResolvedValue(['/abs/img1.jpg', '/abs/img2.jpg', '/abs/img3.jpg']);

    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      const yes = callCount % 2 === 0;
      return Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content: yes ? 'YES' : 'NO' } }] }),
      });
    });

    const result = await executeImageAnalyze(
      { paths: ['/abs/*.jpg'], filter: '有猫的图片' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta?.total).toBe(3);
      expect(result.meta?.matched).toBeGreaterThanOrEqual(1);
    }
  });

  it('batch mode returns FS_ERROR when no matches', async () => {
    globMock.mockResolvedValue([]);
    const result = await executeImageAnalyze(
      { paths: ['/abs/nope/*.jpg'], filter: 'cat' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('FS_ERROR');
    }
  });

  it('falls back to openrouter when zhipu fails', async () => {
    getConfigServiceMock.mockReturnValue({
      getApiKey: vi.fn((p: string) => (p === 'openrouter' ? 'or-key' : 'zhipu-key')),
    });

    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ ok: false, status: 500, text: async () => 'err' });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'gemini result' } }] }),
      });
    });

    const result = await executeImageAnalyze(
      { path: '/abs/p.png' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('gemini result');
    }
  });

  it('rejects when canUseTool denies', async () => {
    const result = await executeImageAnalyze(
      { path: '/abs/p.png' },
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
    const result = await executeImageAnalyze(
      { path: '/abs/p.png' },
      makeCtx({ abortSignal: ctrl.signal }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ABORTED');
    }
  });

  it('rejects when neither path nor (paths+filter) given', async () => {
    const result = await executeImageAnalyze({}, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
    }
  });

  it('rejects non-existent file', async () => {
    accessMock.mockRejectedValue(new Error('ENOENT'));
    const result = await executeImageAnalyze(
      { path: '/abs/missing.png' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('FS_ERROR');
    }
  });

  it('rejects unsupported format', async () => {
    const result = await executeImageAnalyze(
      { path: '/abs/file.svg' },
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
    statMock.mockResolvedValue({ size: 30 * 1024 * 1024 });
    const result = await executeImageAnalyze(
      { path: '/abs/p.png' },
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
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    });
    const onProgress = vi.fn();
    await executeImageAnalyze(
      { path: '/abs/p.png' },
      makeCtx(),
      allowAll,
      onProgress,
    );
    expect(onProgress).toHaveBeenCalledWith({ stage: 'starting', detail: 'image_analyze' });
    expect(onProgress).toHaveBeenCalledWith({ stage: 'completing', percent: 100 });
  });
});
