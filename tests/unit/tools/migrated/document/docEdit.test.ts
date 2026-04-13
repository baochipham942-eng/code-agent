// ============================================================================
// DocEdit (native ToolModule) Tests — P0-6.3 Batch 7
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

// -----------------------------------------------------------------------------
// Mock legacy executors
// -----------------------------------------------------------------------------

const executeExcelEditMock = vi.fn();
const executeDocxEditMock = vi.fn();

vi.mock('../../../../../src/main/tools/excel/excelEdit', () => ({
  executeExcelEdit: (...args: unknown[]) => executeExcelEditMock(...args),
}));

vi.mock('../../../../../src/main/tools/document/docxEdit', () => ({
  executeDocxEdit: (...args: unknown[]) => executeDocxEditMock(...args),
}));

import { docEditModule } from '../../../../../src/main/tools/migrated/document/docEdit';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

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
  const handler = await docEditModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

beforeEach(() => {
  executeExcelEditMock.mockReset();
  executeDocxEditMock.mockReset();
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('docEditModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(docEditModule.schema.name).toBe('DocEdit');
      expect(docEditModule.schema.category).toBe('document');
      expect(docEditModule.schema.permissionLevel).toBe('write');
      expect(docEditModule.schema.readOnly).toBe(false);
      expect(docEditModule.schema.allowInPlanMode).toBe(false);
      expect(docEditModule.schema.inputSchema.required).toEqual(['file_path', 'operations']);
    });
  });

  describe('validation & errors', () => {
    it('rejects missing file_path', async () => {
      const result = await run({ operations: [{ action: 'set_cell' }] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects empty operations array', async () => {
      const result = await run({ file_path: '/tmp/a.xlsx', operations: [] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects unsupported extension', async () => {
      const result = await run({ file_path: '/tmp/a.txt', operations: [{}] });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toContain('Unsupported format');
      }
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run(
        { file_path: '/tmp/a.xlsx', operations: [{}] },
        makeCtx(),
        denyAll,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const result = await run({ file_path: '/tmp/a.xlsx', operations: [{}] }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });
  });

  describe('xlsx dispatch', () => {
    it('happy path delegates to executeExcelEdit', async () => {
      executeExcelEditMock.mockResolvedValue({
        success: true,
        output: 'Excel saved',
        metadata: { sheets: 1 },
      });
      const result = await run({
        file_path: '/tmp/report.xlsx',
        operations: [{ action: 'set_cell', cell: 'A1', value: 1 }],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toBe('Excel saved');
        expect(result.meta).toEqual({ sheets: 1 });
      }
      expect(executeExcelEditMock).toHaveBeenCalledTimes(1);
    });

    it('returns failure when executeExcelEdit reports success:false', async () => {
      executeExcelEditMock.mockResolvedValue({
        success: false,
        error: 'sheet missing',
        metadata: { snapshotId: 'snap-1' },
      });
      const result = await run({
        file_path: '/tmp/report.xlsx',
        operations: [{ action: 'set_cell' }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('sheet missing');
        expect(result.meta).toEqual({ snapshotId: 'snap-1' });
      }
    });
  });

  describe('docx dispatch', () => {
    it('happy path delegates to executeDocxEdit', async () => {
      executeDocxEditMock.mockResolvedValue({
        success: true,
        output: 'Word saved',
        metadata: { paragraphs: 5 },
      });
      const result = await run({
        file_path: '/tmp/spec.docx',
        operations: [{ action: 'replace_text', search: 'a', replace: 'b' }],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toBe('Word saved');
        expect(result.meta).toEqual({ paragraphs: 5 });
      }
      expect(executeDocxEditMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('pptx dispatch', () => {
    it('returns NOT_INITIALIZED when resolver missing', async () => {
      const result = await run({
        file_path: '/tmp/deck.pptx',
        operations: [{ action: 'replace_title', text: 'New' }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('NOT_INITIALIZED');
        expect(result.error).toContain('PPT editing requires the ppt_edit tool');
      }
    });

    it('happy path loops through operations via resolver', async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce({ success: true, output: 'op1 done' })
        .mockResolvedValueOnce({ success: true, output: 'op2 done' });
      const ctx = makeCtx({
        resolver: { has: vi.fn().mockReturnValue(true), execute },
      } as unknown as Partial<ToolContext>);

      const result = await run(
        {
          file_path: '/tmp/deck.pptx',
          operations: [
            { action: 'replace_title', text: 'A' },
            { action: 'replace_title', text: 'B' },
          ],
        },
        ctx,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('PPT edited (2 operations)');
        expect(result.output).toContain('op1 done');
        expect(result.output).toContain('op2 done');
        expect(result.meta).toMatchObject({ operationCount: 2, outputPath: '/tmp/deck.pptx' });
      }
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it('returns error with completedOps when middle op fails', async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce({ success: true, output: 'op1 ok' })
        .mockResolvedValueOnce({ success: false, error: 'bad slide' });
      const ctx = makeCtx({
        resolver: { has: vi.fn().mockReturnValue(true), execute },
      } as unknown as Partial<ToolContext>);

      const result = await run(
        {
          file_path: '/tmp/deck.pptx',
          operations: [
            { action: 'replace_title', text: 'A' },
            { action: 'replace_title', text: 'B' },
            { action: 'replace_title', text: 'C' },
          ],
        },
        ctx,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('PPT edit failed at operation 2');
        expect(result.error).toContain('bad slide');
        expect(result.meta).toMatchObject({ completedOps: ['op1 ok'] });
      }
    });

    it('returns ABORTED with completedOps when abort fires mid-loop', async () => {
      const ctrl = new AbortController();
      const execute = vi.fn().mockImplementationOnce(async () => {
        ctrl.abort(); // abort after first op completes
        return { success: true, output: 'first done' };
      });
      const ctx = makeCtx({
        abortSignal: ctrl.signal,
        resolver: { has: vi.fn().mockReturnValue(true), execute },
      } as unknown as Partial<ToolContext>);

      const result = await run(
        {
          file_path: '/tmp/deck.pptx',
          operations: [
            { action: 'replace_title', text: 'A' },
            { action: 'replace_title', text: 'B' },
          ],
        },
        ctx,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('ABORTED');
        expect(result.meta).toMatchObject({ completedOps: ['first done'] });
      }
    });
  });

  describe('onProgress', () => {
    it('emits starting progress', async () => {
      executeExcelEditMock.mockResolvedValue({ success: true, output: 'ok' });
      const onProgress = vi.fn();
      await run(
        { file_path: '/tmp/a.xlsx', operations: [{ action: 'set_cell' }] },
        makeCtx(),
        allowAll,
        onProgress,
      );
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
    });
  });
});
