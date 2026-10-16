import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import ExcelJS from 'exceljs';
import { executeExcelEdit } from '../../../../src/host/tools/excel/excelEdit';
import type { ToolContext } from '../../../../src/host/tools/types';

// executeExcelEdit 不读 context；按 excelAutomate.test.ts 的夹具惯例给最小形状。
function makeCtx(workingDirectory: string): ToolContext {
  return { workingDirectory } as unknown as ToolContext;
}

async function makeXlsx(dir: string): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('原始数据');
  const file = path.join(dir, '销售数据分析.xlsx');
  await workbook.xlsx.writeFile(file);
  return file;
}

async function readSheetNames(file: string): Promise<string[]> {
  const reread = new ExcelJS.Workbook();
  await reread.xlsx.readFile(file);
  return reread.worksheets.map((ws) => ws.name);
}

describe('executeExcelEdit add_sheet 表名别名', () => {
  it('accepts the sheet alias the card turn actually sends', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'excel-edit-alias-'));
    try {
      const file = await makeXlsx(dir);
      // r5 真实失败形态：schema 文档未列 add_sheet 参数，模型按 set_cell 先例传 sheet
      const result = await executeExcelEdit(
        {
          file_path: file,
          operations: [{ action: 'add_sheet', sheet: '汇总分析' } as never],
        },
        makeCtx(dir),
      );
      expect(result.success).toBe(true);
      await expect(readSheetNames(file)).resolves.toEqual(['原始数据', '汇总分析']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('still honors the documented name parameter', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'excel-edit-name-'));
    try {
      const file = await makeXlsx(dir);
      const result = await executeExcelEdit(
        {
          file_path: file,
          operations: [{ action: 'add_sheet', name: '汇总分析' } as never],
        },
        makeCtx(dir),
      );
      expect(result.success).toBe(true);
      await expect(readSheetNames(file)).resolves.toEqual(['原始数据', '汇总分析']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('fails loudly instead of silently creating a placeholder sheet', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'excel-edit-missing-'));
    try {
      const file = await makeXlsx(dir);
      const result = await executeExcelEdit(
        {
          file_path: file,
          operations: [{ action: 'add_sheet' } as never],
        },
        makeCtx(dir),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('add_sheet requires a sheet name');
      // 失败后快照回滚，磁盘上不得多出 sheet2 之类的占位表
      await expect(readSheetNames(file)).resolves.toEqual(['原始数据']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
