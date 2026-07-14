import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import XLSX from 'xlsx';
import ExcelJS from 'exceljs';

// 表格定点反馈的坐标对账测试：真 xlsx → 真提取 handler → UI 的 A1 换算 → 真 DocEdit 执行器。
//
// 为什么必须整条链一起测：预览侧算「位置」和写入侧用「位置」是两套代码，中间没有翻译层。
// 只测其中一侧，另一侧怎么错都照不出来——既有的真模型验收脚本自述「零 UI」、手工构造
// B2，从不经过 UI 的 A1 计算，所以行错位和工作表错位两个洞在它眼皮底下活了很久。
//
// 这里模拟的是一个「完全听话的模型」：把锚点给的 sheet/cell 原样交给 DocEdit。模型听不听话
// 由付费验收脚本 scripts/acceptance/locality-feedback-sheet-e2e.ts 管；坐标本身对不对，
// 由这个免费的确定性测试守住。

vi.mock('../../../src/host/ipc/adminGuard', () => ({
  isCurrentUserAdmin: () => true,
  getAdminAccessIpcError: () => null,
  assertAdminAccess: vi.fn(),
}));

import { registerSettingsHandlers } from '../../../src/host/ipc/settings.ipc';
import { executeExcelEdit } from '../../../src/host/tools/excel/excelEdit';
import { sheetCellRef } from '../../../src/shared/livePreview/sheetCoords';
import { buildLocalityFeedbackMessage } from '../../../src/shared/livePreview/localityFeedback';

type RawHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

interface SheetPreview {
  name: string;
  headers: string[];
  rows: unknown[][];
  rowCount: number;
}

const SALES_COLUMN = 1; // 「销售额」列（0-based）→ A1 里的 B 列

let handlers: Map<string, RawHandler>;
let workDir: string;

beforeEach(async () => {
  handlers = new Map<string, RawHandler>();
  registerSettingsHandlers(
    { handle: (ch: string, fn: RawHandler) => handlers.set(ch, fn) } as never,
    () => ({}) as never,
  );
  workDir = await mkdtemp(join(tmpdir(), 'sheet-locality-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function extract(filePath: string): Promise<SheetPreview[]> {
  const handler = handlers.get('extract-excel-json');
  if (!handler) throw new Error('extract-excel-json 未注册');
  const { sheets } = (await handler(null, filePath)) as { sheets: SheetPreview[] };
  return sheets;
}

/** 中间夹一个空行的月份表：xlsx 第 1 行表头 / 第 2 行一月 / 第 3 行空 / 第 4 行三月 */
function monthlySheet(march: number): unknown[][] {
  return [['月份', '销售额'], ['一月', march / 3], [], ['三月', march]];
}

async function writeWorkbook(name: string, sheets: Record<string, unknown[][]>): Promise<string> {
  const wb = XLSX.utils.book_new();
  for (const [sheetName, aoa] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName);
  }
  const filePath = join(workDir, name);
  await writeFile(filePath, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  return filePath;
}

async function readCell(filePath: string, sheetName: string, cell: string): Promise<unknown> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.getWorksheet(sheetName);
  if (!ws) throw new Error(`工作表 ${sheetName} 不存在`);
  return ws.getCell(cell).value;
}

/**
 * 复刻用户在预览里点某一行的动作：从真实提取结果里按内容找到那一行，
 * 用 UI 同一个换算函数得出 A1，再拼成生产构造器要的锚点。
 */
function clickCellInPreview(sheet: SheetPreview, filePath: string, rowText: string) {
  const dataRowIndex = sheet.rows.findIndex((r) => r?.[0] === rowText);
  expect(dataRowIndex).toBeGreaterThanOrEqual(0); // 正向断言：预览里确实有这一行可点
  return {
    kind: 'sheet' as const,
    filePath,
    cell: sheetCellRef(dataRowIndex, SALES_COLUMN),
    sheetName: sheet.name,
  };
}

describe('表格定点反馈：从 UI 坐标出发改到源文件', () => {
  it('有空行的表：点「三月」那行 → 真的改 xlsx 第 4 行，前后行不动', async () => {
    const filePath = await writeWorkbook('blank-row.xlsx', { Sheet1: monthlySheet(300) });
    const [sheet] = await extract(filePath);

    const anchor = clickCellInPreview(sheet, filePath, '三月');
    // 「三月」在 xlsx 里是第 4 行；空行若被压缩，这里会算成 B3
    expect(anchor.cell).toBe('B4');

    // 听话的模型把锚点坐标原样交给 DocEdit
    const result = await executeExcelEdit(
      { file_path: filePath, operations: [{ action: 'set_cell', sheet: anchor.sheetName, cell: anchor.cell, value: 999 }] },
      {} as never,
    );
    expect(result.success).toBe(true);

    expect(await readCell(filePath, 'Sheet1', 'B4')).toBe(999); // 目标真被改到
    expect(await readCell(filePath, 'Sheet1', 'B2')).toBe(100); // 「一月」纹丝不动
    expect(await readCell(filePath, 'Sheet1', 'B3')).toBeFalsy(); // 空行没被误写
  });

  it('多 sheet 工作簿：在第 2 张表点 → 真的改第 2 张，第 1 张纹丝不动', async () => {
    const filePath = await writeWorkbook('multi-sheet.xlsx', {
      Sheet1: monthlySheet(300),
      Summary: monthlySheet(3000),
    });
    const sheets = await extract(filePath);
    expect(sheets.map((s) => s.name)).toEqual(['Sheet1', 'Summary']); // 正向断言：两张表都提取到了

    const anchor = clickCellInPreview(sheets[1], filePath, '三月');
    expect(anchor.sheetName).toBe('Summary'); // 锚点带着真实表名，否则写侧会默默落到第一张表

    const result = await executeExcelEdit(
      { file_path: filePath, operations: [{ action: 'set_cell', sheet: anchor.sheetName, cell: anchor.cell, value: 999 }] },
      {} as never,
    );
    expect(result.success).toBe(true);

    expect(await readCell(filePath, 'Summary', 'B4')).toBe(999); // 用户点的那张表被改
    expect(await readCell(filePath, 'Sheet1', 'B4')).toBe(300); // 第 1 张表纹丝不动
  });

  it('锚点消息把工作表名和 A1 一起带给模型', async () => {
    const filePath = await writeWorkbook('multi-sheet.xlsx', {
      Sheet1: monthlySheet(300),
      Summary: monthlySheet(3000),
    });
    const sheets = await extract(filePath);
    const anchor = clickCellInPreview(sheets[1], filePath, '三月');

    const prompt = buildLocalityFeedbackMessage(anchor, '把这个单元格改成 999');

    expect(prompt).toContain('Summary'); // 缺了它，模型没有任何线索指向第 2 张表
    expect(prompt).toContain('B4');
    expect(prompt).toContain(filePath);
  });
});
