// ============================================================================
// ExcelAutomate (native ToolModule) Tests — P1 Wave 2
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

// -----------------------------------------------------------------------------
// Mock subordinate executors / legacy tools
// -----------------------------------------------------------------------------

const executeReadXlsxMock = vi.fn();
const executeExcelEditMock = vi.fn();
const excelGenerateExecuteMock = vi.fn();
const xlwingsExecuteMock = vi.fn();
const executePythonScriptMock = vi.fn();

vi.mock('../../../../../src/main/tools/modules/network/readXlsx', () => ({
  executeReadXlsx: (...args: unknown[]) => executeReadXlsxMock(...args),
}));

vi.mock('../../../../../src/main/tools/excel/excelEdit', () => ({
  executeExcelEdit: (...args: unknown[]) => executeExcelEditMock(...args),
}));

vi.mock('../../../../../src/main/tools/modules/network/excelGenerate', () => ({
  executeExcelGenerate: (...args: unknown[]) => excelGenerateExecuteMock(...args),
}));

vi.mock('../../../../../src/main/tools/modules/network/xlwingsExecute', () => ({
  executeXlwingsExecute: (...args: unknown[]) => xlwingsExecuteMock(...args),
}));

vi.mock('../../../../../src/main/tools/utils/pythonBridge', () => ({
  executePythonScript: (...args: unknown[]) => executePythonScriptMock(...args),
}));

import { excelAutomateModule } from '../../../../../src/main/tools/modules/excel/excelAutomate';

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
    workingDir: '/tmp',
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
  onProgress?: (p: { stage: string; percent?: number; detail?: string }) => void,
) {
  const handler = await excelAutomateModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

beforeEach(() => {
  executeReadXlsxMock.mockReset();
  executeExcelEditMock.mockReset();
  excelGenerateExecuteMock.mockReset();
  xlwingsExecuteMock.mockReset();
  executePythonScriptMock.mockReset();
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('excelAutomateModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata aligned with legacy contract', () => {
      expect(excelAutomateModule.schema.name).toBe('ExcelAutomate');
      expect(excelAutomateModule.schema.category).toBe('excel');
      expect(excelAutomateModule.schema.permissionLevel).toBe('write');
      expect(excelAutomateModule.schema.inputSchema.required).toEqual(['action']);
    });

    it('action enum covers all 7 actions', () => {
      const actionEnum =
        (excelAutomateModule.schema.inputSchema.properties as Record<string, { enum?: string[] }>)
          .action.enum;
      expect(actionEnum).toEqual([
        'read',
        'generate',
        'edit',
        'automate',
        'list_sheets',
        'get_range',
        'validate_formulas',
      ]);
    });
  });

  describe('input validation', () => {
    it('returns INVALID_ARGS when action is missing', async () => {
      const r = await run({});
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('INVALID_ARGS');
        expect(r.error).toMatch(/action must be a string/);
      }
    });

    it('returns INVALID_ARGS for unknown action', async () => {
      const r = await run({ action: 'bogus' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('INVALID_ARGS');
        expect(r.error).toMatch(/Unknown action/);
      }
    });
  });

  describe('permission gate', () => {
    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const r = await run({ action: 'read', file_path: 'a.xlsx' }, makeCtx(), denyAll);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('PERMISSION_DENIED');
      }
      expect(executeReadXlsxMock).not.toHaveBeenCalled();
    });
  });

  describe('abort', () => {
    it('returns ABORTED when abortSignal is already aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const r = await run({ action: 'read', file_path: 'a.xlsx' }, ctx);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('ABORTED');
      }
      expect(executeReadXlsxMock).not.toHaveBeenCalled();
    });
  });

  describe('action: read', () => {
    it('requires file_path', async () => {
      const r = await run({ action: 'read' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('INVALID_ARGS');
    });

    it('delegates to executeReadXlsx and forwards result', async () => {
      executeReadXlsxMock.mockResolvedValue({
        ok: true,
        output: 'table content',
        meta: { rowCount: 3 },
      });
      const r = await run({
        action: 'read',
        file_path: 'a.xlsx',
        sheet: 'Sheet1',
        format: 'json',
        max_rows: 100,
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.output).toBe('table content');
      expect(executeReadXlsxMock).toHaveBeenCalledTimes(1);
      const [params] = executeReadXlsxMock.mock.calls[0];
      expect(params).toMatchObject({
        file_path: 'a.xlsx',
        sheet: 'Sheet1',
        format: 'json',
        max_rows: 100,
      });
    });
  });

  describe('action: generate', () => {
    it('requires title and data', async () => {
      const r = await run({ action: 'generate', title: 'foo' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('INVALID_ARGS');
    });

    it('delegates to native executeExcelGenerate', async () => {
      excelGenerateExecuteMock.mockResolvedValue({
        ok: true,
        output: 'Excel ok',
        meta: { filePath: '/tmp/foo.xlsx' },
      });
      const r = await run({
        action: 'generate',
        title: 'Sales',
        data: '[]',
        theme: 'colorful',
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.output).toBe('Excel ok');
      expect(excelGenerateExecuteMock).toHaveBeenCalledTimes(1);
    });

    it('propagates native failure as protocol error', async () => {
      excelGenerateExecuteMock.mockResolvedValue({
        ok: false,
        error: '生成失败',
      });
      const r = await run({ action: 'generate', title: 't', data: 'd' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('生成失败');
    });
  });

  describe('action: edit', () => {
    it('requires file_path', async () => {
      const r = await run({ action: 'edit' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('INVALID_ARGS');
    });

    it('requires operations', async () => {
      const r = await run({ action: 'edit', file_path: 'a.xlsx' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('INVALID_ARGS');
    });

    it('delegates to executeExcelEdit', async () => {
      executeExcelEditMock.mockResolvedValue({
        success: true,
        output: 'edit done',
        metadata: { changeCount: 1 },
      });
      const r = await run({
        action: 'edit',
        file_path: 'a.xlsx',
        operations: [{ action: 'set_cell', cell: 'A1', value: 1 }],
        dry_run: true,
      });
      expect(r.ok).toBe(true);
      expect(executeExcelEditMock).toHaveBeenCalledTimes(1);
      const [params] = executeExcelEditMock.mock.calls[0];
      expect(params).toMatchObject({ file_path: 'a.xlsx', dry_run: true });
    });
  });

  describe('action: automate', () => {
    it('requires operation', async () => {
      const r = await run({ action: 'automate' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('INVALID_ARGS');
    });

    it('delegates to native executeXlwingsExecute', async () => {
      xlwingsExecuteMock.mockResolvedValue({
        ok: true,
        output: 'xlwings ok',
      });
      const r = await run({
        action: 'automate',
        operation: 'check',
        file_path: 'a.xlsx',
      });
      expect(r.ok).toBe(true);
      expect(xlwingsExecuteMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('action: list_sheets', () => {
    it('requires file_path', async () => {
      const r = await run({ action: 'list_sheets' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('INVALID_ARGS');
    });

    it('uses xlwings result when xlwings succeeds', async () => {
      xlwingsExecuteMock.mockResolvedValue({
        ok: true,
        output: 'sheets via xlwings',
      });
      const r = await run({ action: 'list_sheets', file_path: 'a.xlsx' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.output).toBe('sheets via xlwings');
      // Should not fall through to executeReadXlsx
      expect(executeReadXlsxMock).not.toHaveBeenCalled();
    });

    it('falls back to read_xlsx availableSheets when xlwings fails', async () => {
      xlwingsExecuteMock.mockResolvedValue({ ok: false, error: 'no xlwings' });
      executeReadXlsxMock.mockResolvedValue({
        ok: true,
        output: 'first sheet',
        meta: { availableSheets: ['Sheet1', 'Q1', 'Q2'] },
      });
      const r = await run({ action: 'list_sheets', file_path: 'a.xlsx' });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.output).toContain('📋 工作表列表 (3)');
        expect(r.output).toContain('1. Sheet1');
        expect(r.output).toContain('2. Q1');
        expect(r.output).toContain('3. Q2');
      }
    });
  });

  describe('action: get_range', () => {
    it('requires range', async () => {
      const r = await run({ action: 'get_range', file_path: 'a.xlsx' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('INVALID_ARGS');
    });

    it('delegates to xlwings read with range', async () => {
      xlwingsExecuteMock.mockResolvedValue({ ok: true, output: 'A1:B2 data' });
      const r = await run({
        action: 'get_range',
        file_path: 'a.xlsx',
        range: 'A1:B2',
      });
      expect(r.ok).toBe(true);
      const [params] = xlwingsExecuteMock.mock.calls[0];
      expect(params).toMatchObject({ operation: 'read', range: 'A1:B2' });
    });
  });

  describe('action: validate_formulas', () => {
    it('requires file_path', async () => {
      const r = await run({ action: 'validate_formulas' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('INVALID_ARGS');
    });

    it('returns EXCEL_ERROR when python script fails', async () => {
      executePythonScriptMock.mockResolvedValue({
        success: false,
        error: 'libreoffice not found',
      });
      const r = await run({ action: 'validate_formulas', file_path: '/tmp/a.xlsx' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('EXCEL_ERROR');
        expect(r.error).toBe('libreoffice not found');
      }
    });

    it('formats clean status output', async () => {
      executePythonScriptMock.mockResolvedValue({
        success: true,
        total_formulas: 5,
        total_errors: 0,
        status: 'clean',
        error_summary: [],
      });
      const r = await run({ action: 'validate_formulas', file_path: '/tmp/a.xlsx' });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.output).toContain('公式总数: 5');
        expect(r.output).toContain('✅ 无错误');
      }
    });

    it('formats error details when found', async () => {
      executePythonScriptMock.mockResolvedValue({
        success: true,
        total_formulas: 3,
        total_errors: 1,
        status: 'errors',
        error_summary: [
          { sheet: 'Sheet1', cell: 'B2', error_type: '#REF!', formula: '=B1+#REF!' },
        ],
      });
      const r = await run({ action: 'validate_formulas', file_path: '/tmp/a.xlsx' });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.output).toContain('⚠️ 发现错误');
        expect(r.output).toContain('Sheet1!B2: #REF!');
      }
    });
  });

  describe('progress events', () => {
    it('emits starting + completing for happy path', async () => {
      executeReadXlsxMock.mockResolvedValue({ ok: true, output: 'x' });
      const events: Array<{ stage: string; percent?: number; detail?: string }> = [];
      await run(
        { action: 'read', file_path: 'a.xlsx' },
        makeCtx(),
        allowAll,
        (p) => events.push(p),
      );
      const stages = events.map((e) => e.stage);
      expect(stages[0]).toBe('starting');
      expect(stages[stages.length - 1]).toBe('completing');
    });
  });
});
