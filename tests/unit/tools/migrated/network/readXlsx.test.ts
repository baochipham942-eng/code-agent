// ============================================================================
// read_xlsx (native ToolModule) Tests — P0-6.3 Batch 8
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

// --- fs mock ---
const existsSyncMock = vi.fn();

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: (...args: unknown[]) => existsSyncMock(...args),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

// --- dataFingerprintStore mock ---
const recordMock = vi.fn();
vi.mock('../../../../../src/main/tools/dataFingerprint', () => ({
  dataFingerprintStore: { record: (...args: unknown[]) => recordMock(...args) },
}));

// --- ExcelJS mock ---
// Build a mock Workbook whose readFile populates a configurable list of
// worksheets. Each worksheet exposes name, actualRowCount, and eachRow().
type MockSheet = {
  name: string;
  rowsRaw: unknown[][]; // first row = header
};

// State injected via globalThis so the hoisted vi.mock factory can read it
// (vi.mock is hoisted above all top-level code, so closure variables are TDZ).
interface ExcelMockState {
  sheets: MockSheet[];
  shouldThrow: Error | null;
}
const STATE_KEY = '__readXlsxTestState__';
(globalThis as unknown as Record<string, ExcelMockState>)[STATE_KEY] = {
  sheets: [],
  shouldThrow: null,
};
function state(): ExcelMockState {
  return (globalThis as unknown as Record<string, ExcelMockState>)[STATE_KEY];
}

vi.mock('exceljs', () => {
  function buildWorksheet(sheet: MockSheet) {
    return {
      name: sheet.name,
      actualRowCount: sheet.rowsRaw.length,
      eachRow(
        _opts: { includeEmpty: boolean },
        cb: (row: { values: unknown[] }, rowNumber: number) => void,
      ) {
        sheet.rowsRaw.forEach((row, idx) => {
          cb({ values: [undefined, ...row] }, idx + 1);
        });
      },
    };
  }
  class MockWorkbook {
    worksheets: ReturnType<typeof buildWorksheet>[] = [];
    xlsx = {
      readFile: async (_p: string) => {
        const s = (globalThis as unknown as Record<string, ExcelMockState>)[STATE_KEY];
        if (s.shouldThrow) throw s.shouldThrow;
        this.worksheets = s.sheets.map(buildWorksheet);
      },
    };
    getWorksheet(name: string) {
      return this.worksheets.find((w) => w.name === name);
    }
  }
  return { default: { Workbook: MockWorkbook } };
});

import { readXlsxModule } from '../../../../../src/main/tools/migrated/network/readXlsx';

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
  const handler = await readXlsxModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

beforeEach(() => {
  existsSyncMock.mockReset();
  recordMock.mockReset();
  existsSyncMock.mockReturnValue(true);
  state().shouldThrow = null;
  state().sheets = [
    {
      name: 'Sheet1',
      rowsRaw: [
        ['Name', 'Age', 'City'],
        ['Alice', 30, 'NYC'],
        ['Bob', 25, 'LA'],
      ],
    },
  ];
});

describe('readXlsxModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(readXlsxModule.schema.name).toBe('read_xlsx');
      expect(readXlsxModule.schema.category).toBe('network');
      expect(readXlsxModule.schema.permissionLevel).toBe('read');
      expect(readXlsxModule.schema.readOnly).toBe(true);
      expect(readXlsxModule.schema.allowInPlanMode).toBe(true);
      expect(readXlsxModule.schema.inputSchema.required).toEqual(['file_path']);
    });
  });

  describe('validation & errors', () => {
    it('rejects missing file_path', async () => {
      const result = await run({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects invalid format', async () => {
      const result = await run({ file_path: '/abs/data.xlsx', format: 'yaml' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toContain('format must be');
      }
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run({ file_path: '/abs/data.xlsx' }, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const result = await run({ file_path: '/abs/data.xlsx' }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });

    it('returns ENOENT when file missing', async () => {
      existsSyncMock.mockReturnValue(false);
      const result = await run({ file_path: '/abs/missing.xlsx' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ENOENT');
    });

    it('rejects non-xlsx/xls extension', async () => {
      const result = await run({ file_path: '/abs/data.csv' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toContain('.xlsx/.xls');
      }
    });
  });

  describe('formats', () => {
    it('table format produces markdown table', async () => {
      const result = await run({ file_path: '/abs/data.xlsx' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('| Name | Age | City |');
        expect(result.output).toContain('| Alice | 30 | NYC |');
        expect(result.output).toContain('| Bob | 25 | LA |');
      }
    });

    it('json format returns JSON array', async () => {
      const result = await run({ file_path: '/abs/data.xlsx', format: 'json' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('"Name": "Alice"');
        expect(result.output).toContain('"Age": 30');
      }
    });

    it('csv format returns comma-separated values', async () => {
      const result = await run({ file_path: '/abs/data.xlsx', format: 'csv' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Name,Age,City');
        expect(result.output).toContain('Alice,30,NYC');
      }
    });
  });

  describe('sheet selection', () => {
    beforeEach(() => {
      state().sheets = [
        {
          name: 'Sheet1',
          rowsRaw: [
            ['A', 'B'],
            [1, 2],
          ],
        },
        {
          name: 'Summary',
          rowsRaw: [
            ['X', 'Y'],
            [9, 10],
          ],
        },
      ];
    });

    it('selects sheet by name', async () => {
      const result = await run({ file_path: '/abs/data.xlsx', sheet: 'Summary' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('工作表: Summary');
        expect(result.output).toContain('| 9 | 10 |');
      }
    });

    it('selects sheet by index', async () => {
      const result = await run({ file_path: '/abs/data.xlsx', sheet: 1 as unknown as string });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('工作表: Summary');
    });

    it('returns INVALID_ARGS when sheet name not found', async () => {
      const result = await run({ file_path: '/abs/data.xlsx', sheet: 'Missing' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toContain('工作表不存在');
      }
    });

    it('defaults to first worksheet when sheet omitted', async () => {
      const result = await run({ file_path: '/abs/data.xlsx' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('工作表: Sheet1');
    });
  });

  describe('row truncation & metadata', () => {
    it('respects max_rows', async () => {
      state().sheets = [
        {
          name: 'Sheet1',
          rowsRaw: [
            ['col'],
            ['r1'],
            ['r2'],
            ['r3'],
            ['r4'],
            ['r5'],
          ],
        },
      ];
      const result = await run({ file_path: '/abs/data.xlsx', max_rows: 2 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('| r1 |');
        expect(result.output).toContain('| r2 |');
        expect(result.output).not.toContain('| r3 |');
      }
    });

    it('records data fingerprint', async () => {
      await run({ file_path: '/abs/data.xlsx' });
      expect(recordMock).toHaveBeenCalledTimes(1);
      const arg = recordMock.mock.calls[0][0];
      expect(arg.sheetName).toBe('Sheet1');
      expect(arg.columnNames).toEqual(['Name', 'Age', 'City']);
    });

    it('wraps ExcelJS errors as FS_ERROR', async () => {
      state().shouldThrow = new Error('xlsx parse error');
      const result = await run({ file_path: '/abs/data.xlsx' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('FS_ERROR');
        expect(result.error).toContain('xlsx parse error');
      }
    });
  });

  describe('onProgress', () => {
    it('emits starting progress', async () => {
      const onProgress = vi.fn();
      await run({ file_path: '/abs/data.xlsx' }, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
    });
  });
});
