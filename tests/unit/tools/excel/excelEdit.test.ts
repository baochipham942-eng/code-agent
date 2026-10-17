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

describe('executeExcelEdit set_column_width missing column', () => {
  it('returns an explicit error instead of a bare toUpperCase TypeError', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'excel-edit-colwidth-'));
    try {
      const file = await makeXlsx(dir);
      // starter-card 实测失败形态：模型漏传 column，工具回 undefined.toUpperCase 的 TypeError
      const result = await executeExcelEdit(
        {
          file_path: file,
          operations: [{ action: 'set_column_width', width: 20 } as never],
        },
        makeCtx(dir),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('set_column_width requires column');
      expect(result.error).not.toContain('toUpperCase');
      // 失败后快照回滚，磁盘文件保持原样
      await expect(readSheetNames(file)).resolves.toEqual(['原始数据']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('still sets the width when column is provided', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'excel-edit-colwidth-ok-'));
    try {
      const file = await makeXlsx(dir);
      const result = await executeExcelEdit(
        {
          file_path: file,
          operations: [{ action: 'set_column_width', column: 'A', width: 20 }],
        },
        makeCtx(dir),
      );
      expect(result.success).toBe(true);
      const reread = new ExcelJS.Workbook();
      await reread.xlsx.readFile(file);
      expect(reread.getWorksheet('原始数据')!.getColumn('A').width).toBe(20);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('executeExcelEdit insert_columns missing after', () => {
  it('returns an explicit error instead of a bare toUpperCase TypeError', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'excel-edit-inscol-'));
    try {
      const file = await makeXlsx(dir);
      // schema 文档未列 insert_columns 参数：模型漏传 after 时工具回 undefined.toUpperCase 的 TypeError
      const result = await executeExcelEdit(
        {
          file_path: file,
          operations: [{ action: 'insert_columns', count: 2 }],
        },
        makeCtx(dir),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('insert_columns requires after');
      expect(result.error).not.toContain('toUpperCase');
      // 失败后快照回滚，磁盘文件保持原样
      await expect(readSheetNames(file)).resolves.toEqual(['原始数据']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('still inserts the column when after is provided', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'excel-edit-inscol-ok-'));
    try {
      const file = await makeXlsx(dir);
      const result = await executeExcelEdit(
        {
          file_path: file,
          operations: [
            { action: 'set_cell', cell: 'A1', value: '名称' },
            { action: 'insert_columns', after: 'A', headers: ['新增'] },
          ],
        },
        makeCtx(dir),
      );
      expect(result.success).toBe(true);
      const reread = new ExcelJS.Workbook();
      await reread.xlsx.readFile(file);
      expect(reread.getWorksheet('原始数据')!.getCell('A1').value).toBe('名称');
      expect(reread.getWorksheet('原始数据')!.getCell('B1').value).toBe('新增');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('executeExcelEdit delete_columns missing from', () => {
  it('returns an explicit error instead of a bare toUpperCase TypeError', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'excel-edit-delcol-'));
    try {
      const file = await makeXlsx(dir);
      const result = await executeExcelEdit(
        {
          file_path: file,
          operations: [{ action: 'delete_columns', count: 1 }],
        },
        makeCtx(dir),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('delete_columns requires from');
      expect(result.error).not.toContain('toUpperCase');
      // 失败后快照回滚，磁盘文件保持原样
      await expect(readSheetNames(file)).resolves.toEqual(['原始数据']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('still deletes the column when from is provided', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'excel-edit-delcol-ok-'));
    try {
      const file = await makeXlsx(dir);
      const result = await executeExcelEdit(
        {
          file_path: file,
          operations: [
            { action: 'set_cell', cell: 'A1', value: '名称' },
            { action: 'set_cell', cell: 'B1', value: '单价' },
            { action: 'delete_columns', from: 'A', count: 1 },
          ],
        },
        makeCtx(dir),
      );
      expect(result.success).toBe(true);
      const reread = new ExcelJS.Workbook();
      await reread.xlsx.readFile(file);
      expect(reread.getWorksheet('原始数据')!.getCell('A1').value).toBe('单价');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
