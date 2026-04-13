// ============================================================================
// read_docx (native ToolModule) Tests — P0-6.3 Batch 8
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

const existsSyncMock = vi.fn();
const readFileSyncMock = vi.fn();

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: (...args: unknown[]) => existsSyncMock(...args),
    readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
  };
});

const extractRawTextMock = vi.fn();
const convertToHtmlMock = vi.fn();

vi.mock('mammoth', () => ({
  default: {
    extractRawText: (...args: unknown[]) => extractRawTextMock(...args),
    convertToHtml: (...args: unknown[]) => convertToHtmlMock(...args),
  },
}));

import { readDocxModule } from '../../../../../src/main/tools/migrated/network/readDocx';

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
  const handler = await readDocxModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

beforeEach(() => {
  existsSyncMock.mockReset();
  readFileSyncMock.mockReset();
  extractRawTextMock.mockReset();
  convertToHtmlMock.mockReset();
  existsSyncMock.mockReturnValue(true);
  readFileSyncMock.mockReturnValue(Buffer.from('docx-bytes'));
  extractRawTextMock.mockResolvedValue({ value: 'plain text body', messages: [] });
  convertToHtmlMock.mockResolvedValue({
    value: '<h1>Title</h1><p>body</p>',
    messages: [],
  });
});

describe('readDocxModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(readDocxModule.schema.name).toBe('read_docx');
      expect(readDocxModule.schema.category).toBe('network');
      expect(readDocxModule.schema.permissionLevel).toBe('read');
      expect(readDocxModule.schema.readOnly).toBe(true);
      expect(readDocxModule.schema.allowInPlanMode).toBe(true);
      expect(readDocxModule.schema.inputSchema.required).toEqual(['file_path']);
    });
  });

  describe('validation & errors', () => {
    it('rejects missing file_path', async () => {
      const result = await run({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects invalid format', async () => {
      const result = await run({ file_path: '/abs/doc.docx', format: 'pdf' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toContain('format must be');
      }
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run({ file_path: '/abs/doc.docx' }, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const result = await run({ file_path: '/abs/doc.docx' }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });

    it('returns ENOENT when file missing', async () => {
      existsSyncMock.mockReturnValue(false);
      const result = await run({ file_path: '/abs/missing.docx' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ENOENT');
    });

    it('rejects non-.docx extension', async () => {
      const result = await run({ file_path: '/abs/old.doc' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toContain('仅支持 .docx');
      }
    });

    it('wraps mammoth errors as FS_ERROR', async () => {
      extractRawTextMock.mockRejectedValue(new Error('corrupt'));
      const result = await run({ file_path: '/abs/doc.docx' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('FS_ERROR');
        expect(result.error).toContain('corrupt');
      }
    });
  });

  describe('formats', () => {
    it('text format calls extractRawText', async () => {
      extractRawTextMock.mockResolvedValue({ value: 'hello', messages: [] });
      const result = await run({ file_path: '/abs/doc.docx' });
      expect(extractRawTextMock).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('hello');
        expect(result.output).toContain('格式: text');
      }
    });

    it('html format calls convertToHtml', async () => {
      convertToHtmlMock.mockResolvedValue({
        value: '<p>html body</p>',
        messages: [],
      });
      const result = await run({ file_path: '/abs/doc.docx', format: 'html' });
      expect(convertToHtmlMock).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('<p>html body</p>');
        expect(result.output).toContain('格式: html');
      }
    });

    it('markdown format converts html to markdown', async () => {
      convertToHtmlMock.mockResolvedValue({
        value: '<h1>Title</h1><p>para</p>',
        messages: [],
      });
      const result = await run({ file_path: '/abs/doc.docx', format: 'markdown' });
      expect(convertToHtmlMock).toHaveBeenCalled();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('# Title');
        expect(result.output).toContain('para');
      }
    });

    it('appends mammoth warning messages to output', async () => {
      extractRawTextMock.mockResolvedValue({
        value: 'hi',
        messages: [{ message: 'unrecognized style: Heading9' }],
      });
      const result = await run({ file_path: '/abs/doc.docx' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('unrecognized style: Heading9');
    });
  });

  describe('onProgress', () => {
    it('emits starting progress', async () => {
      const onProgress = vi.fn();
      await run({ file_path: '/abs/doc.docx' }, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
    });
  });
});
