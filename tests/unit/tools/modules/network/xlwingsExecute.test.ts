// ============================================================================
// xlwings_execute (native ToolModule) Tests — P1 Wave 4 D2b
//
// xlwings COM bridge 仅在 Windows / macOS 装有 Excel 时可用，单测 mock
// executePythonScript 跑全部 7 个 action 的契约。
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

const { executePythonScriptMock } = vi.hoisted(() => ({
  executePythonScriptMock: vi.fn(),
}));

vi.mock('../../../../../src/main/tools/utils/pythonBridge', () => ({
  executePythonScript: (...args: unknown[]) => executePythonScriptMock(...args),
  resolveScriptPath: (n: string) => n,
}));

import { xlwingsExecuteModule } from '../../../../../src/main/tools/modules/network/xlwingsExecute';

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
  const handler = await xlwingsExecuteModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

const envOk = { xlwings_available: true, excel_available: true };

beforeEach(() => {
  executePythonScriptMock.mockReset();
});

describe('xlwingsExecuteModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(xlwingsExecuteModule.schema.name).toBe('xlwings_execute');
      expect(xlwingsExecuteModule.schema.category).toBe('network');
      expect(xlwingsExecuteModule.schema.permissionLevel).toBe('write');
      expect(xlwingsExecuteModule.schema.inputSchema.required).toEqual(['operation']);
    });

    it('exposes 7 operations via enum', () => {
      const opProp = (xlwingsExecuteModule.schema.inputSchema.properties as Record<string, { enum?: string[] }>).operation;
      expect(opProp.enum).toEqual([
        'check', 'get_active', 'list_sheets', 'read', 'write', 'run_macro', 'create_chart',
      ]);
    });
  });

  describe('validation & error gates', () => {
    it('rejects missing operation', async () => {
      const result = await run({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects invalid operation', async () => {
      const result = await run({ operation: 'foo' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run({ operation: 'check' }, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const result = await run({ operation: 'check' }, makeCtx({ abortSignal: ctrl.signal }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });

    it('rejects run_macro without macro_name', async () => {
      executePythonScriptMock.mockResolvedValue(envOk);
      const result = await run({ operation: 'run_macro' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });
  });

  describe('check operation', () => {
    it('reports xlwings missing', async () => {
      executePythonScriptMock.mockResolvedValue({ xlwings_available: false, excel_available: true });
      const result = await run({ operation: 'check' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('xlwings 未安装');
    });

    it('reports Excel missing', async () => {
      executePythonScriptMock.mockResolvedValue({ xlwings_available: true, excel_available: false });
      const result = await run({ operation: 'check' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('Excel 不可用');
    });

    it('reports environment ready when both available', async () => {
      executePythonScriptMock.mockResolvedValue(envOk);
      const result = await run({ operation: 'check' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('xlwings 环境就绪');
    });
  });

  describe('environment guard for non-check operations', () => {
    it('errors when xlwings missing', async () => {
      executePythonScriptMock.mockResolvedValue({ xlwings_available: false, excel_available: true });
      const result = await run({ operation: 'list_sheets' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('xlwings 未安装');
    });
  });

  describe('happy paths (one per action)', () => {
    it('formats list_sheets output', async () => {
      executePythonScriptMock
        .mockResolvedValueOnce(envOk)
        .mockResolvedValueOnce({
          success: true, workbook: 'book1.xlsx', count: 2, sheets: ['Sheet1', 'Sheet2'],
        });
      const result = await run({ operation: 'list_sheets' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('book1.xlsx');
        expect(result.output).toContain('1. Sheet1');
        expect(result.output).toContain('2. Sheet2');
      }
    });

    it('formats get_active output with sheet info', async () => {
      executePythonScriptMock
        .mockResolvedValueOnce(envOk)
        .mockResolvedValueOnce({
          success: true,
          workbook: 'book.xlsx',
          path: '/tmp/book.xlsx',
          active_sheet: 'Sheet1',
          sheets: [{ name: 'Sheet1', rows: 10, cols: 5 }],
        });
      const result = await run({ operation: 'get_active' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('当前工作簿: book.xlsx');
        expect(result.output).toContain('Sheet1 (10 行 × 5 列)');
      }
    });

    it('formats read output as Markdown table', async () => {
      executePythonScriptMock
        .mockResolvedValueOnce(envOk)
        .mockResolvedValueOnce({
          success: true,
          workbook: 'b.xlsx',
          sheet: 'Sheet1',
          range: 'A1:B2',
          rows: 2,
          cols: 2,
          data: [['a', 'b'], [1, 2]],
        });
      const result = await run({ operation: 'read', range: 'A1:B2' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('| 列1 | 列2 |');
      }
    });

    it('handles write with save flag', async () => {
      executePythonScriptMock
        .mockResolvedValueOnce(envOk)
        .mockResolvedValueOnce({
          success: true,
          message: '已写入 1 单元格',
          workbook: 'b.xlsx',
          sheet: 'Sheet1',
        });
      const result = await run({
        operation: 'write',
        range: 'A1',
        data: [['x']],
        save: false,
      });
      expect(result.ok).toBe(true);
      // Verify save=false was passed through
      const call = executePythonScriptMock.mock.calls[1] as unknown[];
      const argsArr = call[1] as string[];
      const paramsIdx = argsArr.indexOf('--params');
      const sentParams = JSON.parse(argsArr[paramsIdx + 1]) as Record<string, unknown>;
      expect(sentParams.save).toBe(false);
    });

    it('handles run_macro with args', async () => {
      executePythonScriptMock
        .mockResolvedValueOnce(envOk)
        .mockResolvedValueOnce({
          success: true,
          message: 'macro done',
          workbook: 'b.xlsx',
          return_value: 42,
        });
      const result = await run({
        operation: 'run_macro',
        macro_name: 'MyMacro',
        macro_args: [1, 2],
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('返回值: 42');
    });

    it('handles create_chart', async () => {
      executePythonScriptMock
        .mockResolvedValueOnce(envOk)
        .mockResolvedValueOnce({
          success: true,
          message: 'chart created',
          chart_type: 'bar',
          data_range: 'A1:B5',
        });
      const result = await run({
        operation: 'create_chart',
        range: 'A1:B5',
        chart_type: 'bar',
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('图表类型: bar');
    });
  });

  describe('path resolution', () => {
    it('joins relative file_path against ctx.workingDir', async () => {
      executePythonScriptMock
        .mockResolvedValueOnce(envOk)
        .mockResolvedValueOnce({ success: true, workbook: 'r.xlsx' });
      await run({ operation: 'list_sheets', file_path: 'rel.xlsx' });
      const argsArr = executePythonScriptMock.mock.calls[1][1] as string[];
      const sentParams = JSON.parse(argsArr[argsArr.indexOf('--params') + 1]);
      expect(sentParams.file_path).toBe('/tmp/work/rel.xlsx');
    });

    it('keeps absolute file_path as-is', async () => {
      executePythonScriptMock
        .mockResolvedValueOnce(envOk)
        .mockResolvedValueOnce({ success: true, workbook: 'r.xlsx' });
      await run({ operation: 'list_sheets', file_path: '/abs/path.xlsx' });
      const argsArr = executePythonScriptMock.mock.calls[1][1] as string[];
      const sentParams = JSON.parse(argsArr[argsArr.indexOf('--params') + 1]);
      expect(sentParams.file_path).toBe('/abs/path.xlsx');
    });
  });

  describe('failure passthrough', () => {
    it('returns error when python reports failure', async () => {
      executePythonScriptMock
        .mockResolvedValueOnce(envOk)
        .mockResolvedValueOnce({ success: false, error: 'workbook not found' });
      const result = await run({ operation: 'list_sheets' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('workbook not found');
    });

    it('catches thrown errors', async () => {
      executePythonScriptMock.mockRejectedValueOnce(new Error('python crashed'));
      const result = await run({ operation: 'check' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('python crashed');
    });
  });

  describe('onProgress', () => {
    it('emits starting and completing stages', async () => {
      executePythonScriptMock.mockResolvedValue(envOk);
      const onProgress = vi.fn();
      await run({ operation: 'check' }, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
      expect(stages).toContain('completing');
    });
  });
});
