// ============================================================================
// screenshot_page (native ToolModule) Tests — P1 Wave 4 D2c
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

const { existsSyncMock, mkdirSyncMock, writeFileSyncMock, statSyncMock, readFileSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn().mockReturnValue(true),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  statSyncMock: vi.fn().mockReturnValue({ size: 4096 }),
  readFileSyncMock: vi.fn().mockReturnValue(Buffer.from('img-data')),
}));

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
  mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
  writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
  statSync: (...args: unknown[]) => statSyncMock(...args),
  readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
}));

const { getConfigServiceMock } = vi.hoisted(() => ({
  getConfigServiceMock: vi.fn(),
}));

vi.mock('../../../../../src/main/services', () => ({
  getConfigService: () => getConfigServiceMock(),
}));

import { screenshotPageModule, executeScreenshotPage } from '../../../../../src/main/tools/modules/network/screenshotPage';

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

describe('screenshot_page — schema', () => {
  it('declares correct name and category', () => {
    expect(screenshotPageModule.schema.name).toBe('screenshot_page');
    expect(screenshotPageModule.schema.category).toBe('network');
    expect(screenshotPageModule.schema.permissionLevel).toBe('network');
    expect(screenshotPageModule.schema.readOnly).toBe(true);
    expect(screenshotPageModule.schema.allowInPlanMode).toBe(true);
  });

  it('requires url', () => {
    expect(screenshotPageModule.schema.inputSchema.required).toEqual(['url']);
  });
});

describe('screenshot_page — execute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockReturnValue({ size: 4096 });
    getConfigServiceMock.mockReturnValue({
      getApiKey: vi.fn().mockReturnValue('test-zhipu-key'),
    });
  });

  it('happy path via Thum.io', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });

    const result = await executeScreenshotPage(
      { url: 'https://example.com' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta?.api).toBe('Thum.io');
      expect(writeFileSyncMock).toHaveBeenCalled();
      expect((result.meta?.attachment as Record<string, unknown>)?.category).toBe('image');
    }
  });

  it('falls back to Microlink when Thum.io fails', async () => {
    let calls = 0;
    global.fetch = vi.fn().mockImplementation((url) => {
      calls++;
      const u = String(url);
      if (u.includes('thum.io')) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      if (u.includes('microlink')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            status: 'success',
            data: { screenshot: { url: 'https://cdn/img.png' } },
          }),
        });
      }
      // image download
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => new Uint8Array([9, 9]).buffer,
      });
    });

    const result = await executeScreenshotPage(
      { url: 'https://example.com', width: 1024, height: 768, full_page: true },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta?.api).toBe('Microlink');
    }
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('rejects when canUseTool denies', async () => {
    const result = await executeScreenshotPage(
      { url: 'https://example.com' },
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
    const result = await executeScreenshotPage(
      { url: 'https://example.com' },
      makeCtx({ abortSignal: ctrl.signal }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ABORTED');
    }
  });

  it('rejects missing url', async () => {
    const result = await executeScreenshotPage({}, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
    }
  });

  it('rejects invalid URL', async () => {
    const result = await executeScreenshotPage(
      { url: 'not-a-url' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('无效的 URL');
    }
  });

  it('rejects non-http(s) URL', async () => {
    const result = await executeScreenshotPage(
      { url: 'ftp://example.com' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
    }
  });

  it('returns NETWORK_ERROR when all APIs fail', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const result = await executeScreenshotPage(
      { url: 'https://example.com' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NETWORK_ERROR');
    }
  });

  it('runs vision analysis when analyze=true', async () => {
    let urls: string[] = [];
    global.fetch = vi.fn().mockImplementation((url) => {
      urls.push(String(url));
      const u = String(url);
      if (u.includes('thum.io')) {
        return Promise.resolve({
          ok: true,
          arrayBuffer: async () => new Uint8Array([1]).buffer,
        });
      }
      if (u.includes('0ki') || u.includes('bigmodel')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ choices: [{ message: { content: '这是一个登录页面' } }] }),
        });
      }
      return Promise.resolve({ ok: false });
    });

    const result = await executeScreenshotPage(
      { url: 'https://example.com', analyze: true, prompt: '说说看' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('AI 分析结果');
      expect(result.meta?.analyzed).toBe(true);
      expect(result.meta?.analysis).toContain('登录页面');
    }
  });

  it('vision analysis silently skipped without zhipu key', async () => {
    getConfigServiceMock.mockReturnValue({
      getApiKey: vi.fn().mockReturnValue(undefined),
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    });

    const result = await executeScreenshotPage(
      { url: 'https://example.com', analyze: true },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta?.analyzed).toBe(false);
      expect(result.meta?.analysis).toBeNull();
    }
  });

  it('emits onProgress', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    });
    const onProgress = vi.fn();
    await executeScreenshotPage(
      { url: 'https://example.com' },
      makeCtx(),
      allowAll,
      onProgress,
    );
    expect(onProgress).toHaveBeenCalledWith({ stage: 'starting', detail: 'screenshot_page' });
    expect(onProgress).toHaveBeenCalledWith({ stage: 'completing', percent: 100 });
  });
});
