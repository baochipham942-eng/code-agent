// ============================================================================
// screenshot_page (native ToolModule) Tests — P1 Wave 4 D2c
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/host/protocol/tools';

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

vi.mock('../../../../../src/host/services', () => ({
  getConfigService: () => getConfigServiceMock(),
}));

import { screenshotPageModule, executeScreenshotPage } from '../../../../../src/host/tools/modules/network/screenshotPage';

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('screenshot_page — schema', () => {
  it('declares correct name and category', () => {
    expect(screenshotPageModule.schema.name).toBe('screenshot_page');
    expect(screenshotPageModule.schema.category).toBe('network');
    expect(screenshotPageModule.schema.permissionLevel).toBe('network');
    // N-PATHMUTGUARD（2026-08-21 爸拍板）：screenshot_page 会把截图写到 output_path，readOnly 标注改为真值 false；
    // 仍允许在计划模式使用（读网页为主，落盘受 mutation guard 管）。
    expect(screenshotPageModule.schema.readOnly).toBe(false);
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
    getConfigServiceMock.mockReturnValue({ onSettingsUpdated: vi.fn(),
      getApiKey: vi.fn().mockReturnValue('test-zhipu-key'),
    });
  });

  it('happy path via Thum.io', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'screenshot-page-data-'));
    try {
      vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
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
        // 无 output_path 时默认落数据目录下按会话隔离的子目录，不写工作目录（N-RETENTION-SHOTS-APPDIR）
        const expectedDir = escapeRegExp(join(dataDir, 'tool-screenshots', 'test-session'));
        expect(result.meta?.artifact).toMatchObject({
          kind: 'image',
          sourceTool: 'screenshot_page',
          path: expect.stringMatching(new RegExp(`^${expectedDir}/screenshot_example_com_\\d+\\.png$`)),
          mimeType: 'image/png',
          sizeBytes: 4096,
          metadata: {
            url: 'https://example.com',
            width: 1280,
            height: 800,
            fullPage: false,
            format: 'png',
            api: 'Thum.io',
            analyzed: false,
          },
        });
        expect(writeFileSyncMock).toHaveBeenCalled();
        expect((result.meta?.attachment as Record<string, unknown>)?.category).toBe('image');
        expect(String(result.meta?.filePath)).not.toContain('/tmp/work');
      }
    } finally {
      vi.unstubAllEnvs();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('default path writes under the app data dir and leaves pre-existing workspace files untouched', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'screenshot-page-data-'));
    const workingDir = await mkdtemp(join(tmpdir(), 'screenshot-page-work-'));
    const legacyShotDir = join(workingDir, '.screenshots');
    const decoyDefault = join(workingDir, 'screenshot_example_com_1234567890.png');
    const decoyLegacy = join(legacyShotDir, 'screenshot_old.png');
    try {
      vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
      // 工具侧 mkdirSync 被 mock，目录由测试预先建好（生产路径上 mkdir 负责建目录）
      await mkdir(join(dataDir, 'tool-screenshots', 'test-session'), { recursive: true });
      await writeFile(decoyDefault, 'pre-existing decoy');
      await mkdir(legacyShotDir, { recursive: true });
      await writeFile(decoyLegacy, 'legacy decoy');
      const before = (await readdir(workingDir)).sort();

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      });
      let diskWrite: Promise<void> | undefined;
      writeFileSyncMock.mockImplementationOnce((filePath: string, data: Buffer) => {
        diskWrite = writeFile(filePath, data);
      });

      const result = await executeScreenshotPage(
        { url: 'https://example.com' },
        makeCtx({ workingDir }),
        allowAll,
      );
      await diskWrite;

      expect(result.ok).toBe(true);
      if (result.ok) {
        // 新文件落在数据目录的会话子目录
        const sessionDir = join(dataDir, 'tool-screenshots', 'test-session');
        expect(result.meta?.filePath).toMatch(
          new RegExp(`^${escapeRegExp(sessionDir)}/screenshot_example_com_\\d+\\.png$`),
        );
        expect(await readFile(String(result.meta?.filePath))).toEqual(Buffer.from([1, 2, 3]));
        // 工作目录里的既有文件原样保留，目录清单零新增
        expect((await readdir(workingDir)).sort()).toEqual(before);
        expect(await readFile(decoyDefault, 'utf-8')).toBe('pre-existing decoy');
        expect(await readFile(decoyLegacy, 'utf-8')).toBe('legacy decoy');
      }
    } finally {
      vi.unstubAllEnvs();
      await rm(dataDir, { recursive: true, force: true });
      await rm(workingDir, { recursive: true, force: true });
    }
  });

  it('resolves a relative output_path inside ctx.workingDir and writes there', async () => {
    const workingDir = await mkdtemp(join(tmpdir(), 'screenshot-page-'));
    const expectedPath = join(workingDir, 'page.png');
    try {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      });
      let diskWrite: Promise<void> | undefined;
      writeFileSyncMock.mockImplementationOnce((filePath: string, data: Buffer) => {
        diskWrite = writeFile(filePath, data);
      });
      const result = await executeScreenshotPage(
        { url: 'https://example.com', output_path: 'page.png' },
        makeCtx({ workingDir }),
        allowAll,
      );
      await diskWrite;
      expect(result.ok).toBe(true);
      expect(writeFileSyncMock).toHaveBeenCalledWith(expectedPath, expect.any(Buffer));
      expect((await readFile(expectedPath)).length).toBeGreaterThan(0);
      if (result.ok) expect(result.output).toContain(expectedPath);
    } finally {
      await rm(workingDir, { recursive: true, force: true });
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
    const urls: string[] = [];
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
    getConfigServiceMock.mockReturnValue({ onSettingsUpdated: vi.fn(),
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
