// ============================================================================
// read_pdf (native ToolModule) Tests — P0-6.3 Batch 8
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

const accessMock = vi.fn();
const readFileMock = vi.fn();
const statMock = vi.fn();

vi.mock('fs/promises', () => ({
  default: {
    access: (...args: unknown[]) => accessMock(...args),
    readFile: (...args: unknown[]) => readFileMock(...args),
    stat: (...args: unknown[]) => statMock(...args),
  },
  access: (...args: unknown[]) => accessMock(...args),
  readFile: (...args: unknown[]) => readFileMock(...args),
  stat: (...args: unknown[]) => statMock(...args),
}));

const getApiKeyMock = vi.fn();

vi.mock('../../../../../src/main/services', () => ({
  getConfigService: () => ({ getApiKey: getApiKeyMock }),
}));

import { readPdfModule } from '../../../../../src/main/tools/migrated/network/readPdf';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: '/work',
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

async function run(
  args: Record<string, unknown>,
  ctx: ToolContext = makeCtx(),
  canUseTool: CanUseToolFn = allowAll,
  onProgress?: (p: { stage: string }) => void,
) {
  const handler = await readPdfModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

const fetchMock = vi.fn();

beforeEach(() => {
  accessMock.mockReset();
  readFileMock.mockReset();
  statMock.mockReset();
  getApiKeyMock.mockReset();
  fetchMock.mockReset();

  accessMock.mockResolvedValue(undefined);
  readFileMock.mockResolvedValue(Buffer.from('pdf-data'));
  statMock.mockResolvedValue({ size: 1024 * 1024 });

  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeJsonResponse(payload: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

describe('readPdfModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(readPdfModule.schema.name).toBe('read_pdf');
      expect(readPdfModule.schema.category).toBe('network');
      expect(readPdfModule.schema.permissionLevel).toBe('read');
      expect(readPdfModule.schema.readOnly).toBe(true);
      expect(readPdfModule.schema.allowInPlanMode).toBe(true);
      expect(readPdfModule.schema.inputSchema.required).toEqual(['file_path']);
    });
  });

  describe('validation & errors', () => {
    it('rejects missing file_path', async () => {
      const result = await run({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run({ file_path: '/abs/file.pdf' }, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const result = await run({ file_path: '/abs/file.pdf' }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });

    it('returns ENOENT when file missing', async () => {
      const enoent: NodeJS.ErrnoException = new Error('not found');
      enoent.code = 'ENOENT';
      accessMock.mockRejectedValue(enoent);
      const result = await run({ file_path: '/abs/missing.pdf' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ENOENT');
    });

    it('rejects non-pdf extension', async () => {
      const result = await run({ file_path: '/abs/foo.txt' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toContain('PDF');
      }
    });
  });

  describe('happy paths', () => {
    it('uses direct OpenRouter when api key present', async () => {
      getApiKeyMock.mockReturnValue('sk-test-key');
      fetchMock.mockResolvedValue(
        makeJsonResponse({ choices: [{ message: { content: 'PDF summary' } }] }),
      );
      const result = await run({ file_path: '/abs/doc.pdf' });
      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, options] = fetchMock.mock.calls[0];
      expect((options.headers as Record<string, string>).Authorization).toBe('Bearer sk-test-key');
      if (result.ok) {
        expect(result.output).toContain('PDF summary');
        expect(result.output).toContain('视觉模型');
      }
    });

    it('falls back to cloud proxy when no api key', async () => {
      getApiKeyMock.mockReturnValue(undefined);
      fetchMock.mockResolvedValue(
        makeJsonResponse({ choices: [{ message: { content: 'cloud summary' } }] }),
      );
      const result = await run({ file_path: '/abs/doc.pdf' });
      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      if (result.ok) expect(result.output).toContain('cloud summary');
    });

    it('falls back to cloud proxy when direct call fails', async () => {
      getApiKeyMock.mockReturnValue('sk-test-key');
      fetchMock
        .mockResolvedValueOnce(makeJsonResponse({ error: 'rate limited' }, false))
        .mockResolvedValueOnce(
          makeJsonResponse({ choices: [{ message: { content: 'fallback summary' } }] }),
        );
      const result = await run({ file_path: '/abs/doc.pdf' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('fallback summary');
    });

    it('passes custom prompt to model request', async () => {
      getApiKeyMock.mockReturnValue('sk-test-key');
      fetchMock.mockResolvedValue(
        makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
      );
      await run({ file_path: '/abs/doc.pdf', prompt: 'Just summarize page 1' });
      const [, options] = fetchMock.mock.calls[0];
      const body = JSON.parse(options.body as string);
      expect(body.messages[0].content[0].text).toBe('Just summarize page 1');
    });

    it('returns error when both providers fail', async () => {
      getApiKeyMock.mockReturnValue('sk-test-key');
      fetchMock.mockResolvedValue(makeJsonResponse({ error: 'down' }, false));
      const result = await run({ file_path: '/abs/doc.pdf' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('NETWORK_ERROR');
        expect(result.error).toContain('PDF 解析失败');
      }
    });

    it('wraps fetch network errors as NETWORK_ERROR', async () => {
      getApiKeyMock.mockReturnValue(undefined);
      fetchMock.mockRejectedValue(new Error('socket hang up'));
      const result = await run({ file_path: '/abs/doc.pdf' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('NETWORK_ERROR');
    });
  });

  describe('onProgress', () => {
    it('emits starting progress', async () => {
      getApiKeyMock.mockReturnValue('sk-test-key');
      fetchMock.mockResolvedValue(
        makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
      );
      const onProgress = vi.fn();
      await run({ file_path: '/abs/doc.pdf' }, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
    });
  });
});
