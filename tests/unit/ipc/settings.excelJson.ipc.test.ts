import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import XLSX from 'xlsx';

// extract-excel-json 的行坐标契约测试。
//
// 为什么值得测：预览数组的下标就是 SpreadsheetBlock 算 A1 引用（B7）的依据，而定点
// 反馈会把这个 A1 直接交给 DocEdit 改源文件。提取时若丢掉空行，后面每一行的行号都会
// 左移一位——用户点第 4 行、改掉的是第 3 行，且没有任何报错。这类"静默改错用户文件"
// 必须由真文件走真提取来守住，mock 掉解析就等于没测。

vi.mock('../../../src/host/ipc/adminGuard', () => ({
  isCurrentUserAdmin: () => true,
  getAdminAccessIpcError: () => null,
  assertAdminAccess: vi.fn(),
}));

import { registerSettingsHandlers } from '../../../src/host/ipc/settings.ipc';
import { sheetCellRef } from '../../../src/shared/livePreview/sheetCoords';

type RawHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

interface SheetPreview {
  name: string;
  headers: string[];
  rows: unknown[][];
  rowCount: number;
}

let handlers: Map<string, RawHandler>;
let workDir: string;

beforeEach(async () => {
  handlers = new Map<string, RawHandler>();
  registerSettingsHandlers(
    { handle: (ch: string, fn: RawHandler) => handlers.set(ch, fn) } as never,
    () => ({}) as never,
  );
  workDir = await mkdtemp(join(tmpdir(), 'excel-json-ipc-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function extract(filePath: string): Promise<{ sheets: SheetPreview[]; sheetCount: number }> {
  const handler = handlers.get('extract-excel-json');
  if (!handler) throw new Error('extract-excel-json 未注册');
  return (await handler(null, filePath)) as { sheets: SheetPreview[]; sheetCount: number };
}

async function writeWorkbook(name: string, sheets: Record<string, unknown[][]>, ref?: string): Promise<string> {
  const wb = XLSX.utils.book_new();
  for (const [sheetName, aoa] of Object.entries(sheets)) {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    if (ref) ws['!ref'] = ref;
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }
  const filePath = join(workDir, name);
  await writeFile(filePath, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  return filePath;
}

const SALES_COLUMN = 1; // 「销售额」列（0-based）→ A1 里的 B 列

describe('extract-excel-json 行坐标与真实 xlsx 对齐', () => {
  it('中间空行必须保留，否则后续行的 A1 引用会左移', async () => {
    // xlsx 实际布局：第1行表头 / 第2行「一月」/ 第3行空 / 第4行「三月」
    const filePath = await writeWorkbook('blank-row.xlsx', {
      Sheet1: [['月份', '销售额'], ['一月', 100], [], ['三月', 300]],
    });

    const { sheets } = await extract(filePath);
    const rows = sheets[0].rows;

    const marchIndex = rows.findIndex((r) => r?.[0] === '三月');
    expect(marchIndex).toBeGreaterThanOrEqual(0); // 正向断言：确实提取到了数据
    // 「三月」在 xlsx 里是第 4 行 → 销售额单元格必须是 B4
    expect(sheetCellRef(marchIndex, SALES_COLUMN)).toBe('B4');
  });

  it('尾部虚高的 !ref 不会灌进一堆空行，且不破坏对齐', async () => {
    const filePath = await writeWorkbook(
      'inflated-ref.xlsx',
      { Sheet1: [['月份', '销售额'], ['一月', 100], [], ['三月', 300]] },
      'A1:B200',
    );

    const { sheets } = await extract(filePath);
    expect(sheets[0].rows.length).toBe(3); // 一月 / 空 / 三月，不是 199
    const marchIndex = sheets[0].rows.findIndex((r) => r?.[0] === '三月');
    expect(sheetCellRef(marchIndex, SALES_COLUMN)).toBe('B4');
  });

  it('多 sheet 时每张表都带真实表名（DocEdit 靠它定位，缺省会落到第一张表）', async () => {
    const filePath = await writeWorkbook('multi-sheet.xlsx', {
      Sheet1: [['月份', '销售额'], ['一月', 1]],
      Summary: [['月份', '销售额'], ['一月', 999]],
    });

    const { sheets, sheetCount } = await extract(filePath);
    expect(sheetCount).toBe(2);
    expect(sheets.map((s) => s.name)).toEqual(['Sheet1', 'Summary']);
  });
});
