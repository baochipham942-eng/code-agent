// ============================================================================
// excel_generate (P1 Wave 4 D2b — network/document_generation: native ToolModule)
//
// 把 legacy ExcelGenerateTool 的多格式输入解析（JSON/Markdown/CSV/TSV/空格）+
// 5 主题样式（professional/colorful/minimal/dark/financial）整体迁移到 native。
//
// 行为保真：legacy 输出文案、emoji、metadata.attachment 形状 1:1 复刻（评测集依赖）。
// 暴露 executeExcelGenerate 给 modules/excel/excelAutomate dispatcher 复用。
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import ExcelJS from 'exceljs';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { formatFileSize } from '../../utils/fileSize';
import { excelGenerateSchema as schema } from './excelGenerate.schema';

type ExcelTheme = 'professional' | 'colorful' | 'minimal' | 'dark' | 'financial';

interface ExcelGenerateParams {
  title: string;
  data: string | Record<string, unknown>[];
  theme?: ExcelTheme;
  output_path?: string;
  sheet_name?: string;
}

interface ThemeConfig {
  headerBgColor: string;
  headerFontColor: string;
  evenRowBgColor: string;
  oddRowBgColor: string;
  borderColor: string;
  fontName: string;
}

const themeConfigs: Record<ExcelTheme, ThemeConfig> = {
  professional: {
    headerBgColor: '1a365d',
    headerFontColor: 'ffffff',
    evenRowBgColor: 'f7fafc',
    oddRowBgColor: 'ffffff',
    borderColor: 'e2e8f0',
    fontName: 'Arial',
  },
  colorful: {
    headerBgColor: '7c3aed',
    headerFontColor: 'ffffff',
    evenRowBgColor: 'faf5ff',
    oddRowBgColor: 'ffffff',
    borderColor: 'e9d5ff',
    fontName: 'Arial',
  },
  minimal: {
    headerBgColor: 'f3f4f6',
    headerFontColor: '1f2937',
    evenRowBgColor: 'f9fafb',
    oddRowBgColor: 'ffffff',
    borderColor: 'e5e7eb',
    fontName: 'Helvetica',
  },
  dark: {
    headerBgColor: '1f2937',
    headerFontColor: 'ffffff',
    evenRowBgColor: '374151',
    oddRowBgColor: '4b5563',
    borderColor: '6b7280',
    fontName: 'Consolas',
  },
  financial: {
    headerBgColor: '003366',
    headerFontColor: 'ffffff',
    evenRowBgColor: 'f7f9fc',
    oddRowBgColor: 'ffffff',
    borderColor: 'b0c4de',
    fontName: 'Arial',
  },
};

function parseTableData(input: string): Record<string, unknown>[] {
  const lines = input.trim().split('\n').filter((l) => l.trim());
  if (lines.length === 0) return [];

  const isMarkdownTable = lines[0].includes('|');
  if (isMarkdownTable) return parseMarkdownTable(lines);

  const isCSV = lines[0].includes(',');
  if (isCSV) return parseCSV(lines);

  const isTSV = lines[0].includes('\t');
  if (isTSV) return parseTSV(lines);

  return parseSpaceSeparated(lines);
}

function parseMarkdownTable(lines: string[]): Record<string, unknown>[] {
  const dataLines = lines.filter((l) => !l.match(/^\|[\s-|:]+\|$/));
  if (dataLines.length === 0) return [];

  const headers = dataLines[0].split('|').filter((c) => c.trim()).map((c) => c.trim());
  const data: Record<string, unknown>[] = [];

  for (let i = 1; i < dataLines.length; i++) {
    const cells = dataLines[i].split('|').filter((c) => c.trim()).map((c) => c.trim());
    const row: Record<string, unknown> = {};
    headers.forEach((header, idx) => {
      row[header] = parseValue(cells[idx] || '');
    });
    data.push(row);
  }
  return data;
}

function parseCSV(lines: string[]): Record<string, unknown>[] {
  const headers = parseCSVLine(lines[0]);
  const data: Record<string, unknown>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = parseCSVLine(lines[i]);
    const row: Record<string, unknown> = {};
    headers.forEach((header, idx) => {
      row[header] = parseValue(cells[idx] || '');
    });
    data.push(row);
  }
  return data;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function parseTSV(lines: string[]): Record<string, unknown>[] {
  const headers = lines[0].split('\t').map((h) => h.trim());
  const data: Record<string, unknown>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split('\t').map((c) => c.trim());
    const row: Record<string, unknown> = {};
    headers.forEach((header, idx) => {
      row[header] = parseValue(cells[idx] || '');
    });
    data.push(row);
  }
  return data;
}

function parseSpaceSeparated(lines: string[]): Record<string, unknown>[] {
  const headers = lines[0].split(/\s+/).filter((h) => h);
  const data: Record<string, unknown>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(/\s+/).filter((c) => c);
    const row: Record<string, unknown> = {};
    headers.forEach((header, idx) => {
      row[header] = parseValue(cells[idx] || '');
    });
    data.push(row);
  }
  return data;
}

function parseValue(value: string): unknown {
  if (!value) return '';
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== '') return num;
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  return value;
}

export async function executeExcelGenerate(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  const params = args as unknown as ExcelGenerateParams;
  const { title, data } = params;

  if (typeof title !== 'string' || title.length === 0) {
    return { ok: false, error: 'title is required and must be a string', code: 'INVALID_ARGS' };
  }
  if (data === undefined || data === null) {
    return { ok: false, error: 'data is required', code: 'INVALID_ARGS' };
  }

  const theme: ExcelTheme = (params.theme ?? 'professional') as ExcelTheme;
  const sheet_name = params.sheet_name ?? 'Sheet1';
  const output_path = params.output_path;

  try {
    const themeConfig = themeConfigs[theme] || themeConfigs.professional;

    let tableData: Record<string, unknown>[];
    if (typeof data === 'string') {
      tableData = parseTableData(data);
    } else if (Array.isArray(data)) {
      tableData = data;
    } else {
      return { ok: false, error: '数据格式错误：需要 JSON 数组或表格字符串' };
    }

    if (tableData.length === 0) {
      return { ok: false, error: '未能解析出有效数据' };
    }

    const timestamp = Date.now();
    const fileName = `spreadsheet-${timestamp}.xlsx`;
    const outputDir = output_path ? path.dirname(output_path) : ctx.workingDir;
    const finalPath = output_path || path.join(outputDir, fileName);

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Code Agent';
    workbook.created = new Date();

    const worksheet = workbook.addWorksheet(sheet_name);
    const headers = Object.keys(tableData[0]);

    worksheet.addRow([title]);
    const titleRow = worksheet.getRow(1);
    titleRow.font = {
      bold: true,
      size: 16,
      name: themeConfig.fontName,
      color: { argb: themeConfig.headerBgColor },
    };
    titleRow.height = 30;
    worksheet.mergeCells(1, 1, 1, headers.length);

    worksheet.addRow([]);

    worksheet.addRow(headers);
    const headerRow = worksheet.getRow(3);
    headerRow.font = {
      bold: true,
      color: { argb: themeConfig.headerFontColor },
      name: themeConfig.fontName,
    };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: themeConfig.headerBgColor },
    };
    headerRow.height = 25;

    headers.forEach((header, idx) => {
      const column = worksheet.getColumn(idx + 1);
      column.width = Math.max(header.length * 2, 15);
    });

    tableData.forEach((row, rowIdx) => {
      const values = headers.map((h) => row[h]);
      const excelRow = worksheet.addRow(values);

      excelRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: {
          argb: rowIdx % 2 === 0 ? themeConfig.evenRowBgColor : themeConfig.oddRowBgColor,
        },
      };
      excelRow.font = { name: themeConfig.fontName };

      if (theme === 'financial') {
        values.forEach((val, colIdx) => {
          const cell = excelRow.getCell(colIdx + 1);
          if (typeof val === 'number') {
            if (headers[colIdx]?.includes('%') || headers[colIdx]?.includes('率')) {
              cell.numFmt = '0.0%';
            } else {
              cell.numFmt = '#,##0;(#,##0)';
            }
            cell.font = { name: 'Arial', color: { argb: '000000' } };
          } else if (typeof val === 'string' && val) {
            cell.font = { name: 'Arial', color: { argb: '0000FF' } };
          }
        });
      }
    });

    const lastRow = worksheet.rowCount;
    for (let row = 3; row <= lastRow; row++) {
      for (let col = 1; col <= headers.length; col++) {
        const cell = worksheet.getCell(row, col);
        cell.border = {
          top: { style: 'thin', color: { argb: themeConfig.borderColor } },
          bottom: { style: 'thin', color: { argb: themeConfig.borderColor } },
          left: { style: 'thin', color: { argb: themeConfig.borderColor } },
          right: { style: 'thin', color: { argb: themeConfig.borderColor } },
        };
      }
    }

    headers.forEach((_, idx) => {
      const column = worksheet.getColumn(idx + 1);
      let maxLength = 0;
      column.eachCell({ includeEmpty: false }, (cell) => {
        const cellValue = cell.value?.toString() || '';
        maxLength = Math.max(maxLength, cellValue.length);
      });
      column.width = Math.min(Math.max(maxLength * 1.2, 10), 50);
    });

    await workbook.xlsx.writeFile(finalPath);

    const stats = fs.statSync(finalPath);

    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('excel_generate done', {
      path: finalPath,
      rows: tableData.length,
      cols: headers.length,
    });

    return {
      ok: true,
      output: `✅ Excel 表格已生成！

📄 文件路径: ${finalPath}
🎨 主题风格: ${theme}
📊 数据行数: ${tableData.length}
📋 列数: ${headers.length}
📦 文件大小: ${formatFileSize(stats.size)}

点击上方文件路径可直接打开。`,
      meta: {
        filePath: finalPath,
        fileName: path.basename(finalPath),
        fileSize: stats.size,
        rowCount: tableData.length,
        columnCount: headers.length,
        theme,
        outputPath: finalPath,
        attachment: {
          id: `xlsx-${timestamp}`,
          type: 'file',
          category: 'document',
          name: path.basename(finalPath),
          path: finalPath,
          size: stats.size,
          mimeType:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Excel 生成失败: ${message}` };
  }
}

class ExcelGenerateHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeExcelGenerate(args, ctx, canUseTool, onProgress);
  }
}

export const excelGenerateModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ExcelGenerateHandler();
  },
};
