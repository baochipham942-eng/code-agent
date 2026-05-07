// ============================================================================
// PdfAutomate (native dispatcher) Tests — P1 Wave 4 D2b
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

const { executePythonScriptMock, pdfGenerateMock, pdfCompressMock, readPdfMock } = vi.hoisted(() => ({
  executePythonScriptMock: vi.fn(),
  pdfGenerateMock: vi.fn(),
  pdfCompressMock: vi.fn(),
  readPdfMock: vi.fn(),
}));

vi.mock('../../../../../src/main/tools/utils/pythonBridge', () => ({
  executePythonScript: (...args: unknown[]) => executePythonScriptMock(...args),
  resolveScriptPath: (n: string) => n,
}));

vi.mock('../../../../../src/main/tools/modules/network/pdfGenerate', () => ({
  executePdfGenerate: (...args: unknown[]) => pdfGenerateMock(...args),
}));

vi.mock('../../../../../src/main/tools/modules/network/pdfCompress', () => ({
  executePdfCompress: (...args: unknown[]) => pdfCompressMock(...args),
}));

vi.mock('../../../../../src/main/tools/modules/network/readPdf', () => ({
  executeReadPdf: (...args: unknown[]) => readPdfMock(...args),
}));

import { pdfAutomateModule } from '../../../../../src/main/tools/modules/network/pdfAutomate';

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
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

async function run(
  args: Record<string, unknown>,
  ctx: ToolContext = makeCtx(),
  canUseTool: CanUseToolFn = allowAll,
  onProgress?: (p: { stage: string }) => void,
) {
  const handler = await pdfAutomateModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

beforeEach(() => {
  executePythonScriptMock.mockReset();
  pdfGenerateMock.mockReset();
  pdfCompressMock.mockReset();
  readPdfMock.mockReset();
});

describe('pdfAutomateModule (native dispatcher)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(pdfAutomateModule.schema.name).toBe('PdfAutomate');
      expect(pdfAutomateModule.schema.category).toBe('network');
      expect(pdfAutomateModule.schema.permissionLevel).toBe('write');
      expect(pdfAutomateModule.schema.inputSchema.required).toEqual(['action']);
    });

    it('exposes 7 actions via enum', () => {
      const actionProp = (pdfAutomateModule.schema.inputSchema.properties as Record<string, { enum?: string[] }>).action;
      expect(actionProp.enum).toEqual([
        'generate', 'compress', 'read', 'merge', 'split', 'extract_tables', 'convert_to_docx',
      ]);
    });
  });

  describe('validation & error gates', () => {
    it('rejects unknown action', async () => {
      const result = await run({ action: 'bogus' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run({ action: 'generate' }, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const result = await run({ action: 'generate' }, makeCtx({ abortSignal: ctrl.signal }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });
  });

  describe('generate action', () => {
    it('rejects missing title or content', async () => {
      const r1 = await run({ action: 'generate', content: 'x' });
      expect(r1.ok).toBe(false);
      const r2 = await run({ action: 'generate', title: 'T' });
      expect(r2.ok).toBe(false);
    });

    it('delegates to executePdfGenerate with all params', async () => {
      pdfGenerateMock.mockResolvedValue({ ok: true, output: 'gen-ok' });
      const result = await run({
        action: 'generate',
        title: 'T',
        content: 'body',
        theme: 'academic',
        page_size: 'Letter',
        author: '林',
        output_path: '/tmp/x.pdf',
      });
      expect(result.ok).toBe(true);
      expect(pdfGenerateMock).toHaveBeenCalledTimes(1);
      const args = pdfGenerateMock.mock.calls[0][0] as Record<string, unknown>;
      expect(args.title).toBe('T');
      expect(args.content).toBe('body');
      expect(args.theme).toBe('academic');
      expect(args.page_size).toBe('Letter');
      expect(args.author).toBe('林');
      expect(args.output_path).toBe('/tmp/x.pdf');
    });
  });

  describe('compress action', () => {
    it('rejects missing input_path', async () => {
      const result = await run({ action: 'compress' });
      expect(result.ok).toBe(false);
    });

    it('delegates to executePdfCompress', async () => {
      pdfCompressMock.mockResolvedValue({ ok: true, output: 'cmp-ok' });
      await run({ action: 'compress', input_path: 'a.pdf', quality: 'screen' });
      expect(pdfCompressMock).toHaveBeenCalledTimes(1);
      const args = pdfCompressMock.mock.calls[0][0] as Record<string, unknown>;
      expect(args.input_path).toBe('a.pdf');
      expect(args.quality).toBe('screen');
    });
  });

  describe('read action', () => {
    it('rejects missing file_path', async () => {
      const result = await run({ action: 'read' });
      expect(result.ok).toBe(false);
    });

    it('delegates to executeReadPdf with prompt', async () => {
      readPdfMock.mockResolvedValue({ ok: true, output: 'read-ok' });
      await run({ action: 'read', file_path: 'a.pdf', prompt: 'summarize' });
      expect(readPdfMock).toHaveBeenCalledTimes(1);
      const args = readPdfMock.mock.calls[0][0] as Record<string, unknown>;
      expect(args.file_path).toBe('a.pdf');
      expect(args.prompt).toBe('summarize');
    });
  });

  describe('merge action', () => {
    it('rejects fewer than 2 files', async () => {
      const result = await run({
        action: 'merge',
        input_files: ['only.pdf'],
        output_path: 'out.pdf',
      });
      expect(result.ok).toBe(false);
    });

    it('rejects missing output_path', async () => {
      const result = await run({ action: 'merge', input_files: ['a.pdf', 'b.pdf'] });
      expect(result.ok).toBe(false);
    });

    it('resolves relative paths against workingDir and calls pdf_tools.py', async () => {
      executePythonScriptMock.mockResolvedValue({ success: true, file_size: 1024 });
      const result = await run({
        action: 'merge',
        input_files: ['a.pdf', '/abs/b.pdf'],
        output_path: 'merged.pdf',
      });
      expect(result.ok).toBe(true);
      const argsArr = executePythonScriptMock.mock.calls[0][1] as string[];
      expect(argsArr).toContain('--operation');
      expect(argsArr).toContain('merge');
      const sentParams = JSON.parse(argsArr[argsArr.indexOf('--params') + 1]);
      expect(sentParams.input_files).toEqual(['/tmp/work/a.pdf', '/abs/b.pdf']);
      expect(sentParams.output_path).toBe('/tmp/work/merged.pdf');
      if (result.ok) expect(result.output).toContain('PDF 合并完成');
    });

    it('returns failure when python reports error', async () => {
      executePythonScriptMock.mockResolvedValue({ success: false, error: 'merge fail' });
      const result = await run({
        action: 'merge',
        input_files: ['a.pdf', 'b.pdf'],
        output_path: 'out.pdf',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('merge fail');
    });
  });

  describe('split action', () => {
    it('rejects missing ranges', async () => {
      const result = await run({ action: 'split', input_path: 'a.pdf' });
      expect(result.ok).toBe(false);
    });

    it('formats split output with page counts', async () => {
      executePythonScriptMock.mockResolvedValue({
        success: true,
        total_pages: 10,
        outputs: [
          { output_path: '/tmp/work/p1.pdf', pages: '1-5', page_count: 5 },
          { output_path: '/tmp/work/p2.pdf', pages: '6-10', page_count: 5 },
        ],
      });
      const result = await run({
        action: 'split',
        input_path: 'src.pdf',
        ranges: [
          { start: 0, end: 4, output: 'p1.pdf' },
          { start: 5, end: 9, output: 'p2.pdf' },
        ],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('PDF 拆分完成');
        expect(result.output).toContain('p1.pdf (1-5, 5 页)');
        expect(result.meta?.artifacts).toMatchObject([
          { kind: 'document', sourceTool: 'PdfAutomate', path: '/tmp/work/p1.pdf' },
          { kind: 'document', sourceTool: 'PdfAutomate', path: '/tmp/work/p2.pdf' },
        ]);
        expect(result.meta?.pdfAutomateAction).toBe('split');
        expect(result.meta?.resultCount).toBe(2);
        expect(result.meta?.contentLength).toBe(result.output.length);
      }
    });
  });

  describe('extract_tables action', () => {
    it('rejects missing input_path', async () => {
      const result = await run({ action: 'extract_tables' });
      expect(result.ok).toBe(false);
    });

    it('formats tables preview with truncation hint', async () => {
      executePythonScriptMock.mockResolvedValue({
        success: true,
        total_tables: 1,
        tables: [
          {
            page: 1,
            table_index: 0,
            rows: 7,
            columns: 2,
            data: [
              ['a', 'b'],
              [1, 2],
              [3, 4],
              [5, 6],
              [7, 8],
              [9, 10],
              [11, 12],
            ],
          },
        ],
      });
      const result = await run({ action: 'extract_tables', input_path: 'a.pdf' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('提取到 1 个表格');
        expect(result.output).toContain('共 7 行');
      }
    });
  });

  describe('convert_to_docx action', () => {
    it('rejects missing input_path', async () => {
      const result = await run({ action: 'convert_to_docx' });
      expect(result.ok).toBe(false);
    });

    it('passes through page range params', async () => {
      executePythonScriptMock.mockResolvedValue({
        success: true,
        output_path: '/tmp/work/a.docx',
        file_size: 4096,
      });
      const result = await run({
        action: 'convert_to_docx',
        input_path: 'a.pdf',
        start_page: 0,
        end_page: 3,
      });
      expect(result.ok).toBe(true);
      const argsArr = executePythonScriptMock.mock.calls[0][1] as string[];
      const sentParams = JSON.parse(argsArr[argsArr.indexOf('--params') + 1]);
      expect(sentParams.start_page).toBe(0);
      expect(sentParams.end_page).toBe(3);
      expect(sentParams.input_path).toBe('/tmp/work/a.pdf');
      if (result.ok) expect(result.output).toContain('PDF 已转换为 DOCX');
    });
  });

  describe('onProgress', () => {
    it('emits starting stage at entry', async () => {
      pdfGenerateMock.mockResolvedValue({ ok: true, output: 'ok' });
      const onProgress = vi.fn();
      await run({ action: 'generate', title: 'T', content: 'body' }, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
    });
  });
});
