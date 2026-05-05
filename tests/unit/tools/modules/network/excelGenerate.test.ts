// ============================================================================
// excel_generate (native ToolModule) Tests — P1 Wave 4 D2b
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

// -----------------------------------------------------------------------------
// Mocks
// -----------------------------------------------------------------------------

const existsSyncMock = vi.fn().mockReturnValue(true);
const mkdirSyncMock = vi.fn();
const statSyncMock = vi.fn().mockReturnValue({ size: 8192 });

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
  mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
  statSync: (...args: unknown[]) => statSyncMock(...args),
}));

const { writeFileMock } = vi.hoisted(() => ({
  writeFileMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('exceljs', () => {
  class FakeCell {
    value: unknown = '';
    numFmt = '';
    font: unknown = {};
    border: unknown = {};
  }
  class FakeColumn {
    width = 10;
    eachCell(_opts: unknown, _cb: (c: FakeCell) => void) {
      // no-op
    }
  }
  class FakeRow {
    font: unknown = {};
    fill: unknown = {};
    height = 0;
    getCell() {
      return new FakeCell();
    }
  }
  class FakeWorksheet {
    rowCount = 3;
    addRow() {
      this.rowCount++;
      return new FakeRow();
    }
    getRow() {
      return new FakeRow();
    }
    getColumn() {
      return new FakeColumn();
    }
    getCell() {
      return new FakeCell();
    }
    mergeCells() {
      /* no-op */
    }
  }
  class FakeWorkbook {
    creator = '';
    created = new Date();
    xlsx = { writeFile: (p: string) => writeFileMock(p) };
    addWorksheet() {
      return new FakeWorksheet();
    }
  }
  return { default: { Workbook: FakeWorkbook } };
});

import { excelGenerateModule } from '../../../../../src/main/tools/modules/network/excelGenerate';

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
  const handler = await excelGenerateModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

beforeEach(() => {
  existsSyncMock.mockReset().mockReturnValue(true);
  mkdirSyncMock.mockReset();
  statSyncMock.mockReset().mockReturnValue({ size: 8192 });
  writeFileMock.mockReset().mockResolvedValue(undefined);
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('excelGenerateModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(excelGenerateModule.schema.name).toBe('excel_generate');
      expect(excelGenerateModule.schema.category).toBe('network');
      expect(excelGenerateModule.schema.permissionLevel).toBe('write');
      expect(excelGenerateModule.schema.inputSchema.required).toEqual(['title', 'data']);
    });

    it('exposes 5 themes via enum', () => {
      const themeProp = (excelGenerateModule.schema.inputSchema.properties as Record<string, { enum?: string[] }>).theme;
      expect(themeProp.enum).toEqual(['professional', 'colorful', 'minimal', 'dark', 'financial']);
    });
  });

  describe('validation & error gates', () => {
    it('rejects missing title', async () => {
      const result = await run({ data: '[]' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects missing data', async () => {
      const result = await run({ title: 'T' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run({ title: 'T', data: [{ a: 1 }] }, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const result = await run({ title: 'T', data: [{ a: 1 }] }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });

    it('rejects non-array non-string data', async () => {
      const result = await run({ title: 'T', data: 123 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('数据格式错误');
    });

    it('rejects empty parsed data', async () => {
      const result = await run({ title: 'T', data: [] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('未能解析出有效数据');
    });
  });

  describe('input format parsing', () => {
    it('accepts JSON array directly', async () => {
      const result = await run({ title: 'T', data: [{ name: 'a', age: 1 }] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const meta = result.meta as Record<string, unknown>;
        expect(meta.rowCount).toBe(1);
        expect(meta.columnCount).toBe(2);
      }
    });

    it('parses Markdown table', async () => {
      const md = '| name | age |\n|---|---|\n| Lin | 30 |';
      const result = await run({ title: 'T', data: md });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const meta = result.meta as Record<string, unknown>;
        expect(meta.rowCount).toBe(1);
        expect(meta.columnCount).toBe(2);
      }
    });

    it('parses CSV', async () => {
      const csv = 'name,age\nLin,30\nDad,55';
      const result = await run({ title: 'T', data: csv });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const meta = result.meta as Record<string, unknown>;
        expect(meta.rowCount).toBe(2);
      }
    });

    it('parses TSV', async () => {
      const tsv = 'name\tage\nLin\t30';
      const result = await run({ title: 'T', data: tsv });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const meta = result.meta as Record<string, unknown>;
        expect(meta.rowCount).toBe(1);
      }
    });
  });

  describe('happy path', () => {
    it('returns expected metadata + attachment', async () => {
      const result = await run({ title: '员工', data: [{ 姓名: '张三', 部门: '技术部' }] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Excel 表格已生成');
        const meta = result.meta as Record<string, unknown>;
        expect(meta.theme).toBe('professional');
        expect(meta.fileSize).toBe(8192);
        const att = meta.attachment as Record<string, string | number>;
        expect(att.mimeType).toBe(
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        );
        expect(att.category).toBe('document');
        expect(String(att.id).startsWith('xlsx-')).toBe(true);
      }
    });

    it('respects custom output_path', async () => {
      await run({
        title: 'T',
        data: [{ a: 1 }],
        output_path: '/tmp/work/custom.xlsx',
      });
      expect(writeFileMock).toHaveBeenCalledWith('/tmp/work/custom.xlsx');
    });

    it('creates output directory if missing', async () => {
      existsSyncMock.mockReturnValue(false);
      await run({ title: 'T', data: [{ a: 1 }] });
      expect(mkdirSyncMock).toHaveBeenCalledTimes(1);
    });

    it('honors all 5 themes', async () => {
      for (const theme of ['professional', 'colorful', 'minimal', 'dark', 'financial']) {
        const result = await run({ title: 'T', data: [{ a: 1, '%占比': 0.5 }], theme });
        expect(result.ok).toBe(true);
        if (result.ok) {
          const meta = result.meta as Record<string, unknown>;
          expect(meta.theme).toBe(theme);
        }
      }
    });
  });

  describe('error handling', () => {
    it('returns failure when xlsx.writeFile throws', async () => {
      writeFileMock.mockRejectedValueOnce(new Error('disk full'));
      const result = await run({ title: 'T', data: [{ a: 1 }] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('disk full');
    });
  });

  describe('onProgress', () => {
    it('emits starting and completing stages', async () => {
      const onProgress = vi.fn();
      await run({ title: 'T', data: [{ a: 1 }] }, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
      expect(stages).toContain('completing');
    });
  });
});
