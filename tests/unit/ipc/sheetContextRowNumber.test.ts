import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import XLSX from 'xlsx';

// D6：模型自推坐标那条链的行号对账测试。
//
// ADR-040 给「用户点了预览」那条链上了写前 guard，但非程序员最自然的用法是**不点**：
// 直接说「把三月的销售额改成 500」。那条链没有 locator、没有 guard，模型能依赖的两个
// 数据源——附件上下文的 CSV 和 read_xlsx——此前都在压缩空行且都不带行号。模型只能数
// 行，数出来的 B3 会把值写进空行，目标纹丝不动且无任何报错。
//
// 这里守的是「模型不用数行」：两个数据源都必须把 xlsx 真实行号显式交出去，
// 且两者与预览侧（extract-excel-json → sheetCellRef）是同一套行号。
//
// 形态照搬 sheetLocalityRoundtrip：真 xlsx → 真 handler / 真 executor。
// **测试内不手抄任何换算公式**——抄的人不会发现被抄的那份是错的。

vi.mock('../../../src/host/ipc/adminGuard', () => ({
  isCurrentUserAdmin: () => true,
  getAdminAccessIpcError: () => null,
  assertAdminAccess: vi.fn(),
}));

import { registerSettingsHandlers } from '../../../src/host/ipc/settings.ipc';
import { executeReadXlsx } from '../../../src/host/tools/modules/network/readXlsx';
import { sheetCellRef } from '../../../src/shared/livePreview/sheetCoords';

type RawHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

let handlers: Map<string, RawHandler>;
let workDir: string;

beforeEach(async () => {
  handlers = new Map<string, RawHandler>();
  registerSettingsHandlers(
    { handle: (ch: string, fn: RawHandler) => handlers.set(ch, fn) } as never,
    () => ({}) as never,
  );
  workDir = await mkdtemp(join(tmpdir(), 'd6-rownum-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** xlsx 真实布局：第1行表头 / 第2行「一月」/ 第3行空 / 第4行「三月」 */
function monthlySheet(): unknown[][] {
  return [['月份', '销售额'], ['一月', 100], [], ['三月', 300]];
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

async function excelText(filePath: string): Promise<string> {
  const handler = handlers.get('extract-excel-text');
  if (!handler) throw new Error('extract-excel-text 未注册');
  const { text } = (await handler(null, filePath)) as { text: string };
  return text;
}

async function readXlsx(filePath: string, format: 'table' | 'csv' | 'json'): Promise<string> {
  const result = await executeReadXlsx(
    { file_path: filePath, format },
    { workingDir: workDir, abortSignal: new AbortController().signal, logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } } as never,
    async () => ({ allow: true }),
  );
  if (!result.ok) throw new Error(`read_xlsx 失败: ${result.error}`);
  return result.output as string;
}

/** 从模型视角找「三月」那一行，返回它被标注的行号 */
function labelledRowOf(text: string, needle: string): string | undefined {
  return text.split('\n').find((line) => line.includes(needle));
}

/**
 * read_xlsx 的 output 是包着报告的（质量摘要、列画像、Python 提示），JSON 数组只是
 * 其中一段。不能用 lastIndexOf(']') 兜——报告末尾的 `列名: ['月份', ...]` 会被抓进来。
 */
function parseJsonRows(output: string): Array<Record<string, unknown>> {
  const match = /^\[\s*$[\s\S]*?^\]$/m.exec(output);
  expect(match).not.toBeNull();
  return JSON.parse(match![0]) as Array<Record<string, unknown>>;
}

describe('附件上下文的 CSV：模型不用数行', () => {
  it('「三月」标的是 xlsx 真实行号 4，不是压缩后的 3', async () => {
    const filePath = await writeWorkbook('blank-row.xlsx', { Sheet1: monthlySheet() });
    const text = await excelText(filePath);

    const line = labelledRowOf(text, '三月');
    expect(line).toBeDefined();
    // 压缩空行时「三月」会落在第 3 行 → 模型推出 B3 → 写进空行，目标纹丝不动
    expect(line).toMatch(/^4,/);
  });

  it('空行不占篇幅，但跳号让模型看得见它存在', async () => {
    const filePath = await writeWorkbook('blank-row.xlsx', { Sheet1: monthlySheet() });
    const text = await excelText(filePath);
    const dataLines = text.split('\n').filter((l) => /^\d+,/.test(l));

    expect(dataLines.map((l) => l.split(',')[0])).toEqual(['1', '2', '4']); // 3 缺席 = 那里是空行
  });

  it('上下文里写明了行号怎么用，模型不用猜第一列是什么', async () => {
    const filePath = await writeWorkbook('blank-row.xlsx', { Sheet1: monthlySheet() });
    const text = await excelText(filePath);

    expect(text).toContain('xlsx 真实行号');
    expect(text).toContain('B4'); // 给出 A1 换算的实例
  });

  it('单元格内含换行符时，后续行的行号不跟着跑偏', async () => {
    // sheet_to_csv 会把含换行的单元格加引号并跨两行文本输出。若按输出文本的行下标
    // 推行号，从这一行起全错——「四月」会被标成 5 而不是 4。行号必须绑在数据里。
    const filePath = await writeWorkbook('multiline.xlsx', {
      Sheet1: [['月份', '备注'], ['一月', '正常'], ['三月', '第一行\n第二行'], ['四月', '结尾']],
    });
    const text = await excelText(filePath);

    expect(labelledRowOf(text, '三月')).toMatch(/^3,/);
    expect(labelledRowOf(text, '四月')).toMatch(/^4,/);
  });

  it('值里的逗号/引号仍被正确转义（转义归 XLSX，没手搓）', async () => {
    const filePath = await writeWorkbook('escape.xlsx', {
      Sheet1: [['名称', '备注'], ['甲', 'a,b'], ['乙', '他说"好"']],
    });
    const text = await excelText(filePath);

    expect(text).toContain('"a,b"');
    expect(text).toContain('"他说""好"""');
  });
});

describe('read_xlsx：主动核对这条退路也带行号', () => {
  it.each(['table', 'csv'] as const)('%s 格式里「三月」标真实行号 4', async (format) => {
    const filePath = await writeWorkbook('blank-row.xlsx', { Sheet1: monthlySheet() });
    const out = await readXlsx(filePath, format);

    const line = labelledRowOf(out, '三月');
    expect(line).toBeDefined();
    expect(line).toContain('4');
    expect(out).toContain('行号');
  });

  it('json 格式用 __row__ 带出行号', async () => {
    const filePath = await writeWorkbook('blank-row.xlsx', { Sheet1: monthlySheet() });
    const parsed = parseJsonRows(await readXlsx(filePath, 'json'));

    const march = parsed.find((r) => r['月份'] === '三月');
    expect(march?.__row__).toBe(4);
  });

  it('表里自带「行号」列时，真实行号不被它覆盖（json）', async () => {
    // obj[header] 在后面跑，若我们也用「行号」当键，表自身的编号会盖掉真实行号——
    // 模型拿到的就成了业务编号，又一次静默错位。
    const filePath = await writeWorkbook('collide.xlsx', {
      Sheet1: [['行号', '月份'], ['A001', '一月'], [], ['A003', '三月']],
    });
    const parsed = parseJsonRows(await readXlsx(filePath, 'json'));

    const march = parsed.find((r) => r['月份'] === '三月');
    expect(march?.__row__).toBe(4);      // xlsx 真实行号
    expect(march?.['行号']).toBe('A003'); // 表自己的那一列原样保留
  });
});

describe('两个数据源与预览侧同源', () => {
  it('模型看到的行号 = 预览 sheetCellRef 算出的 A1 行号', async () => {
    const filePath = await writeWorkbook('blank-row.xlsx', { Sheet1: monthlySheet() });

    // 预览侧：走真 handler + UI 的换算函数，不手抄
    const jsonHandler = handlers.get('extract-excel-json');
    const { sheets } = (await jsonHandler!(null, filePath)) as {
      sheets: Array<{ name: string; rows: unknown[][] }>;
    };
    const dataRowIndex = sheets[0].rows.findIndex((r) => r?.[0] === '三月');
    const previewA1 = sheetCellRef(dataRowIndex, 1); // 销售额列

    // 模型侧：附件 CSV 标注的行号
    const contextRow = labelledRowOf(await excelText(filePath), '三月')!.split(',')[0];

    // 两侧必须指向同一行——这正是 ADR-040 那个故事的反面
    expect(previewA1).toBe(`B${contextRow}`);
    expect(previewA1).toBe('B4');
  });
});
