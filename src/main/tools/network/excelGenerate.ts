// ============================================================================
// Excel Generate Tool - 生成 Excel 表格 (.xlsx)
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import * as fs from 'fs';
import * as path from 'path';
import ExcelJS from 'exceljs';

// Excel 样式主题
type ExcelTheme = 'professional' | 'colorful' | 'minimal' | 'dark';

interface ExcelGenerateParams {
  title: string;
  data: string | Record<string, unknown>[];
  theme?: ExcelTheme;
  output_path?: string;
  sheet_name?: string;
}

// 主题配置
const themeConfigs: Record<ExcelTheme, {
  headerBgColor: string;
  headerFontColor: string;
  evenRowBgColor: string;
  oddRowBgColor: string;
  borderColor: string;
  fontName: string;
}> = {
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
};

/**
 * 解析 Markdown 表格或 CSV 为数据数组
 */
function parseTableData(input: string): Record<string, unknown>[] {
  const lines = input.trim().split('\n').filter(l => l.trim());

  if (lines.length === 0) {
    return [];
  }

  // 检测是否是 Markdown 表格
  const isMarkdownTable = lines[0].includes('|');

  if (isMarkdownTable) {
    return parseMarkdownTable(lines);
  }

  // 检测是否是 CSV
  const isCSV = lines[0].includes(',');
  if (isCSV) {
    return parseCSV(lines);
  }

  // 检测是否是 TSV（Tab 分隔）
  const isTSV = lines[0].includes('\t');
  if (isTSV) {
    return parseTSV(lines);
  }

  // 默认尝试作为空格分隔
  return parseSpaceSeparated(lines);
}

/**
 * 解析 Markdown 表格
 */
function parseMarkdownTable(lines: string[]): Record<string, unknown>[] {
  // 过滤掉分隔行（只有 - 和 |）
  const dataLines = lines.filter(l => !l.match(/^\|[\s-|:]+\|$/));

  if (dataLines.length === 0) return [];

  // 第一行是表头
  const headers = dataLines[0]
    .split('|')
    .filter(c => c.trim())
    .map(c => c.trim());

  const data: Record<string, unknown>[] = [];

  for (let i = 1; i < dataLines.length; i++) {
    const cells = dataLines[i]
      .split('|')
      .filter(c => c.trim())
      .map(c => c.trim());

    const row: Record<string, unknown> = {};
    headers.forEach((header, idx) => {
      row[header] = parseValue(cells[idx] || '');
    });
    data.push(row);
  }

  return data;
}

/**
 * 解析 CSV
 */
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

/**
 * 解析 CSV 行（处理引号）
 */
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

/**
 * 解析 TSV
 */
function parseTSV(lines: string[]): Record<string, unknown>[] {
  const headers = lines[0].split('\t').map(h => h.trim());
  const data: Record<string, unknown>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split('\t').map(c => c.trim());
    const row: Record<string, unknown> = {};
    headers.forEach((header, idx) => {
      row[header] = parseValue(cells[idx] || '');
    });
    data.push(row);
  }

  return data;
}

/**
 * 解析空格分隔
 */
function parseSpaceSeparated(lines: string[]): Record<string, unknown>[] {
  const headers = lines[0].split(/\s+/).filter(h => h);
  const data: Record<string, unknown>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(/\s+/).filter(c => c);
    const row: Record<string, unknown> = {};
    headers.forEach((header, idx) => {
      row[header] = parseValue(cells[idx] || '');
    });
    data.push(row);
  }

  return data;
}

/**
 * 解析值（自动识别数字）
 */
function parseValue(value: string): unknown {
  if (!value) return '';

  // 尝试解析为数字
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== '') {
    return num;
  }

  // 尝试解析为布尔值
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;

  return value;
}

/**
 * 格式化文件大小
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const excelGenerateTool: Tool = {
  name: 'excel_generate',
  description: `生成 Excel 表格（.xlsx 文件）。

支持多种输入格式：
- JSON 数组：[{"name": "张三", "age": 25}, ...]
- Markdown 表格：| name | age |\\n|---|---|\\n| 张三 | 25 |
- CSV：name,age\\n张三,25
- TSV（Tab 分隔）

**主题选项：**
- professional: 专业商务风格（蓝色表头）
- colorful: 彩色风格（紫色表头）
- minimal: 极简风格（灰色）
- dark: 深色风格

**使用示例：**
\`\`\`
excel_generate { "title": "员工名单", "data": [{"姓名": "张三", "部门": "技术部"}] }
excel_generate { "title": "销售数据", "data": "| 月份 | 销售额 |\\n|---|---|\\n| 1月 | 10000 |" }
excel_generate { "title": "数据表", "data": "name,age\\n张三,25\\n李四,30", "theme": "colorful" }
\`\`\``,
  generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: '表格标题/文件名',
      },
      data: {
        type: 'string',
        description: '表格数据（支持 JSON 数组、Markdown 表格、CSV 或 TSV 格式）',
      },
      theme: {
        type: 'string',
        enum: ['professional', 'colorful', 'minimal', 'dark'],
        description: '主题风格（默认: professional）',
        default: 'professional',
      },
      output_path: {
        type: 'string',
        description: '输出文件路径（默认: 工作目录下的 spreadsheet-{timestamp}.xlsx）',
      },
      sheet_name: {
        type: 'string',
        description: '工作表名称（默认: Sheet1）',
      },
    },
    required: ['title', 'data'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const {
      title,
      data,
      theme = 'professional',
      output_path,
      sheet_name = 'Sheet1',
    } = params as unknown as ExcelGenerateParams;

    try {
      const themeConfig = themeConfigs[theme as ExcelTheme] || themeConfigs.professional;

      // 解析数据
      let tableData: Record<string, unknown>[];
      if (typeof data === 'string') {
        tableData = parseTableData(data);
      } else if (Array.isArray(data)) {
        tableData = data;
      } else {
        return {
          success: false,
          error: '数据格式错误：需要 JSON 数组或表格字符串',
        };
      }

      if (tableData.length === 0) {
        return {
          success: false,
          error: '未能解析出有效数据',
        };
      }

      // 确定输出路径
      const timestamp = Date.now();
      const fileName = `spreadsheet-${timestamp}.xlsx`;
      const outputDir = output_path
        ? path.dirname(output_path)
        : context.workingDirectory;
      const finalPath = output_path || path.join(outputDir, fileName);

      // 确保目录存在
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      // 创建工作簿
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Code Agent';
      workbook.created = new Date();

      // 创建工作表
      const worksheet = workbook.addWorksheet(sheet_name);

      // 获取表头
      const headers = Object.keys(tableData[0]);

      // 添加标题行
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

      // 空行
      worksheet.addRow([]);

      // 添加表头
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

      // 设置列宽
      headers.forEach((header, idx) => {
        const column = worksheet.getColumn(idx + 1);
        column.width = Math.max(header.length * 2, 15);
      });

      // 添加数据行
      tableData.forEach((row, rowIdx) => {
        const values = headers.map(h => row[h]);
        const excelRow = worksheet.addRow(values);

        // 交替行颜色
        excelRow.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: {
            argb: rowIdx % 2 === 0
              ? themeConfig.evenRowBgColor
              : themeConfig.oddRowBgColor
          },
        };
        excelRow.font = { name: themeConfig.fontName };
      });

      // 添加边框
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

      // 自动调整列宽（根据内容）
      headers.forEach((_, idx) => {
        const column = worksheet.getColumn(idx + 1);
        let maxLength = 0;
        column.eachCell({ includeEmpty: false }, (cell) => {
          const cellValue = cell.value?.toString() || '';
          maxLength = Math.max(maxLength, cellValue.length);
        });
        column.width = Math.min(Math.max(maxLength * 1.2, 10), 50);
      });

      // 保存文件
      await workbook.xlsx.writeFile(finalPath);

      // 获取文件信息
      const stats = fs.statSync(finalPath);

      return {
        success: true,
        output: `✅ Excel 表格已生成！

📄 文件路径: ${finalPath}
🎨 主题风格: ${theme}
📊 数据行数: ${tableData.length}
📋 列数: ${headers.length}
📦 文件大小: ${formatFileSize(stats.size)}

点击上方文件路径可直接打开。`,
        metadata: {
          filePath: finalPath,
          fileName: path.basename(finalPath),
          fileSize: stats.size,
          rowCount: tableData.length,
          columnCount: headers.length,
          theme,
          attachment: {
            id: `xlsx-${timestamp}`,
            type: 'file',
            category: 'document',
            name: path.basename(finalPath),
            path: finalPath,
            size: stats.size,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          },
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: `Excel 生成失败: ${error.message}`,
      };
    }
  },
};
