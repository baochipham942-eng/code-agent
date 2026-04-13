// ============================================================================
// ReadDocument (native ToolModule) Tests — P0-6.3 Batch 8
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

const readPdfMock = vi.fn();
const readDocxMock = vi.fn();
const readXlsxMock = vi.fn();

vi.mock('../../../../../src/main/tools/modules/network/readPdf', () => ({
  executeReadPdf: (...args: unknown[]) => readPdfMock(...args),
}));
vi.mock('../../../../../src/main/tools/modules/network/readDocx', () => ({
  executeReadDocx: (...args: unknown[]) => readDocxMock(...args),
}));
vi.mock('../../../../../src/main/tools/modules/network/readXlsx', () => ({
  executeReadXlsx: (...args: unknown[]) => readXlsxMock(...args),
}));

import { readDocumentModule } from '../../../../../src/main/tools/modules/network/readDocument';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: process.cwd(),
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
  const handler = await readDocumentModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

beforeEach(() => {
  readPdfMock.mockReset();
  readDocxMock.mockReset();
  readXlsxMock.mockReset();
  readPdfMock.mockResolvedValue({ ok: true, output: 'pdf-output' });
  readDocxMock.mockResolvedValue({ ok: true, output: 'docx-output' });
  readXlsxMock.mockResolvedValue({ ok: true, output: 'xlsx-output' });
});

describe('readDocumentModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(readDocumentModule.schema.name).toBe('ReadDocument');
      expect(readDocumentModule.schema.category).toBe('network');
      expect(readDocumentModule.schema.permissionLevel).toBe('read');
      expect(readDocumentModule.schema.readOnly).toBe(true);
      expect(readDocumentModule.schema.allowInPlanMode).toBe(true);
      expect(readDocumentModule.schema.inputSchema.required).toEqual(['file_path']);
    });
  });

  describe('validation', () => {
    it('rejects missing file_path', async () => {
      const result = await run({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects empty file_path', async () => {
      const result = await run({ file_path: '' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects file with no extension', async () => {
      const result = await run({ file_path: 'README' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toContain('no extension');
      }
    });

    it('rejects unknown extension', async () => {
      const result = await run({ file_path: 'foo.txt' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toContain('Unsupported file format');
      }
    });

    it('returns PERMISSION_DENIED before dispatch', async () => {
      const result = await run({ file_path: 'doc.pdf' }, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
      expect(readPdfMock).not.toHaveBeenCalled();
    });

    it('returns ABORTED when signal aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const result = await run({ file_path: 'doc.pdf' }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });
  });

  describe('dispatch by extension', () => {
    it('.pdf dispatches to executeReadPdf', async () => {
      const result = await run({ file_path: '/abs/report.pdf' });
      expect(readPdfMock).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toBe('pdf-output');
    });

    it('.docx dispatches to executeReadDocx', async () => {
      const result = await run({ file_path: 'doc.docx' });
      expect(readDocxMock).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toBe('docx-output');
    });

    it('.doc dispatches to executeReadDocx', async () => {
      await run({ file_path: 'doc.doc' });
      expect(readDocxMock).toHaveBeenCalledTimes(1);
    });

    it('.xlsx dispatches to executeReadXlsx', async () => {
      const result = await run({ file_path: 'data.xlsx' });
      expect(readXlsxMock).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toBe('xlsx-output');
    });

    it('.xls dispatches to executeReadXlsx', async () => {
      await run({ file_path: 'old.xls' });
      expect(readXlsxMock).toHaveBeenCalledTimes(1);
    });

    it('extension matching is case-insensitive', async () => {
      await run({ file_path: 'REPORT.PDF' });
      expect(readPdfMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('onProgress', () => {
    it('emits starting progress', async () => {
      const onProgress = vi.fn();
      await run({ file_path: 'doc.pdf' }, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
    });
  });
});
