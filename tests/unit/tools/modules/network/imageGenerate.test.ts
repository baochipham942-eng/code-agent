// ============================================================================
// image_generate (native ToolModule) Tests — P1 Wave 4 D2c
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

const { getConfigServiceMock, getAuthServiceMock } = vi.hoisted(() => ({
  getConfigServiceMock: vi.fn(),
  getAuthServiceMock: vi.fn(),
}));

vi.mock('../../../../../src/main/services', () => ({
  getConfigService: () => getConfigServiceMock(),
}));

vi.mock('../../../../../src/main/services/core/configService', () => ({
  getConfigService: () => getConfigServiceMock(),
}));

vi.mock('../../../../../src/main/services/auth/authService', () => ({
  getAuthService: () => getAuthServiceMock(),
}));

const { safeExecDetachedMock } = vi.hoisted(() => ({
  safeExecDetachedMock: vi.fn(),
}));

vi.mock('../../../../../src/main/utils/safeShell', () => ({
  safeExecDetached: (...args: unknown[]) => safeExecDetachedMock(...args),
}));

import { imageGenerateModule, executeImageGenerate } from '../../../../../src/main/plugins/builtin/imageCreation/imageGenerate';
import { determineImageEngine } from '../../../../../src/main/services/media/imageGenerationService';

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

describe('image_generate — schema', () => {
  it('declares correct name and category', () => {
    expect(imageGenerateModule.schema.name).toBe('image_generate');
    expect(imageGenerateModule.schema.category).toBe('network');
    expect(imageGenerateModule.schema.permissionLevel).toBe('network');
  });

  it('requires prompt', () => {
    expect(imageGenerateModule.schema.inputSchema.required).toEqual(['prompt']);
  });
});

describe('image_generate — engine routing', () => {
  const origEnv = { ...process.env };
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ZHIPU_OFFICIAL_API_KEY;
  });
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('cogview when zhipu official key present', () => {
    process.env.ZHIPU_OFFICIAL_API_KEY = 'official';
    getConfigServiceMock.mockReturnValue({ getApiKey: vi.fn() });
    expect(determineImageEngine()).toBe('cogview');
  });

  it('flux when only openrouter', () => {
    getConfigServiceMock.mockReturnValue({
      getApiKey: vi.fn((p: string) => (p === 'openrouter' ? 'or' : undefined)),
    });
    expect(determineImageEngine()).toBe('flux');
  });

  it('throws when no API key configured', () => {
    getConfigServiceMock.mockReturnValue({ getApiKey: vi.fn().mockReturnValue(undefined) });
    expect(() => determineImageEngine()).toThrow(/API Key/);
  });
});

describe('image_generate — execute', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
    delete process.env.ZHIPU_OFFICIAL_API_KEY;
    delete process.env.CODE_AGENT_CLI_MODE;
    getConfigServiceMock.mockReturnValue({
      getApiKey: vi.fn().mockReturnValue(undefined),
    });
    getAuthServiceMock.mockReturnValue({
      getCurrentUser: vi.fn().mockReturnValue({ isAdmin: false }),
    });
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('happy path cogview returns base64', async () => {
    process.env.ZHIPU_OFFICIAL_API_KEY = 'official-key';
    getConfigServiceMock.mockReturnValue({
      getApiKey: vi.fn().mockReturnValue(undefined),
    });

    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // zhipu image gen
        return Promise.resolve({
          ok: true,
          json: async () => ({ data: [{ url: 'https://cdn/img.png' }] }),
        });
      }
      // image download
      return Promise.resolve({
        ok: true,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      });
    });

    const result = await executeImageGenerate(
      { prompt: '一只猫' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const imageBase64 = result.meta?.imageBase64 as string;
      expect(result.meta?.artifact).toMatchObject({
        kind: 'image',
        sourceTool: 'image_generate',
        mimeType: 'image/png',
        contentLength: imageBase64.length,
        metadata: {
          model: 'cogview-4-250304',
          engine: 'cogview',
          aspectRatio: '1:1',
          embeddedBase64: true,
        },
      });
      expect(result.meta?.engine).toBe('cogview');
      expect(result.meta?.model).toBe('cogview-4-250304');
      expect(result.meta?.imageBase64).toContain('data:image/png;base64,');
      expect(result.meta?.imagePath).toBeUndefined();
    }
  });

  it('saves to file when output_path given', async () => {
    process.env.ZHIPU_OFFICIAL_API_KEY = 'official-key';
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ data: [{ url: 'https://cdn/img.png' }] }),
        });
      }
      return Promise.resolve({
        ok: true,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      });
    });

    const result = await executeImageGenerate(
      { prompt: 'cat', output_path: '/tmp/work/out.png' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    expect(writeFileSyncMock).toHaveBeenCalled();
    if (result.ok) {
      expect(result.meta?.artifact).toMatchObject({
        kind: 'image',
        sourceTool: 'image_generate',
        path: '/tmp/work/out.png',
        mimeType: 'image/png',
        sizeBytes: 1,
        metadata: {
          model: 'cogview-4-250304',
          engine: 'cogview',
          aspectRatio: '1:1',
        },
      });
      expect(result.meta?.imagePath).toBe('/tmp/work/out.png');
      expect(result.meta?.imageBase64).toBeUndefined();
    }
  });

  it('admin user gets FLUX Pro model', async () => {
    getConfigServiceMock.mockReturnValue({
      getApiKey: vi.fn((p: string) => (p === 'openrouter' ? 'or-key' : undefined)),
    });
    getAuthServiceMock.mockReturnValue({
      getCurrentUser: vi.fn().mockReturnValue({ isAdmin: true }),
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            images: [{ image_url: { url: 'data:image/png;base64,xyz' } }],
          },
        }],
      }),
    });

    const result = await executeImageGenerate(
      { prompt: 'test' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta?.engine).toBe('flux');
      expect(result.meta?.model).toBe('black-forest-labs/flux.2-pro');
      expect(result.meta?.isAdmin).toBe(true);
    }
  });

  it('rejects when canUseTool denies', async () => {
    const result = await executeImageGenerate(
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
    const result = await executeImageGenerate(
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
    const result = await executeImageGenerate({}, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
    }
  });

  it('returns failure when API errors', async () => {
    process.env.ZHIPU_OFFICIAL_API_KEY = 'official-key';
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'server error',
    });

    const result = await executeImageGenerate(
      { prompt: 'cat' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('图片生成失败');
    }
  });

  it('emits onProgress', async () => {
    process.env.ZHIPU_OFFICIAL_API_KEY = 'k';
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ data: [{ url: 'https://cdn/i.png' }] }),
        });
      }
      return Promise.resolve({
        ok: true,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      });
    });
    const onProgress = vi.fn();
    await executeImageGenerate(
      { prompt: 'cat' },
      makeCtx(),
      allowAll,
      onProgress,
    );
    expect(onProgress).toHaveBeenCalledWith({ stage: 'starting', detail: 'image_generate' });
    expect(onProgress).toHaveBeenCalledWith({ stage: 'completing', percent: 100 });
  });

  it('CLI mode auto-generates output_path and triggers safeExecDetached', async () => {
    process.env.ZHIPU_OFFICIAL_API_KEY = 'k';
    process.env.CODE_AGENT_CLI_MODE = 'true';
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ data: [{ url: 'https://cdn/i.png' }] }),
        });
      }
      return Promise.resolve({
        ok: true,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      });
    });

    const result = await executeImageGenerate(
      { prompt: 'cat' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    expect(safeExecDetachedMock).toHaveBeenCalled();
    if (result.ok) {
      expect(result.meta?.imagePath).toMatch(/generated-/);
    }
  });
});
