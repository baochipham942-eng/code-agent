// ============================================================================
// Read XLSX Tool - 读取 Excel 表格内容
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import * as fs from 'fs';
import * as path from 'path';
import ExcelJS from 'exceljs';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('ReadXlsx');

interface ReadXlsxParams {
  file_path: string;
  sheet?: string | number;
  format?: 'table' | 'json' | 'csv';
  max_rows?: number;
}

export const readXlsxTool: Tool = {
  name: 'read_xlsx',
  description: `读取 Excel 表格（.xlsx）的内容。

支持输出格式：
- table: Markdown 表格（默认）
- json: JSON 数组
- csv: CSV 格式

**使用示例：**
\`\`\`
read_xlsx { "file_path": "data.xlsx" }
read_xlsx { "file_path": "data.xlsx", "sheet": "Sheet2" }
read_xlsx { "file_path": "data.xlsx", "format": "json", "max_rows": 100 }
\`\`\``,
  generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Excel 文件路径',
      },
      sheet: {
        type: 'string',
        description: '工作表名称或索引（默认: 第一个工作表）',
      },
      format: {
        type: 'string',
        enum: ['table', 'json', 'csv'],
        description: '输出格式（默认: table）',
        default: 'table',
      },
      max_rows: {
        type: 'number',
        description: '最大读取行数（默认: 1000）',
        default: 1000,
      },
    },
    required: ['file_path'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const {
      file_path,
      sheet,
      format = 'table',
      max_rows = 1000,
    } = params as unknown as ReadXlsxParams;

    try {
      // 解析路径
      const absPath = path.isAbsolute(file_path)
        ? file_path
        : path.join(context.workingDirectory, file_path);

      // 检查文件存在
      if (!fs.existsSync(absPath)) {
        return {
          success: false,
          error: `文件不存在: ${absPath}`,
        };
      }

      // 检查扩展名
      const ext = path.extname(absPath).toLowerCase();
      if (ext !== '.xlsx' && ext !== '.xls') {
        return {
          success: false,
          error: `不支持的文件格式: ${ext}，仅支持 .xlsx/.xls`,
        };
      }

      context.emit?.('tool_output', {
        tool: 'read_xlsx',
        message: `📊 正在读取: ${path.basename(absPath)}`,
      });

      // 读取工作簿
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(absPath);

      // 选择工作表
      let worksheet: ExcelJS.Worksheet | undefined;
      if (sheet !== undefined) {
        if (typeof sheet === 'number') {
          worksheet = workbook.worksheets[sheet];
        } else {
          worksheet = workbook.getWorksheet(sheet);
        }
      } else {
        worksheet = workbook.worksheets[0];
      }

      if (!worksheet) {
        const sheetNames = workbook.worksheets.map(ws => ws.name);
        return {
          success: false,
          error: `工作表不存在。可用工作表: ${sheetNames.join(', ')}`,
        };
      }

      // 提取数据
      type CellValue = string | number | boolean | null;
      const rows: CellValue[][] = [];
      let headers: string[] = [];

      worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber > max_rows + 1) return; // +1 for header

        const rowData = row.values as unknown[];
        // Excel row.values 的第一个元素是 undefined（1-indexed）
        const cleanRow: CellValue[] = rowData.slice(1).map(cell => {
          if (cell === null || cell === undefined) return '';
          if (typeof cell === 'object' && cell !== null) {
            // 处理富文本等复杂类型
            if ('text' in cell) return (cell as { text: string }).text;
            if ('result' in cell) return String((cell as { result: unknown }).result);
            return String(cell);
          }
          if (typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') {
            return cell;
          }
          return String(cell);
        });

        if (rowNumber === 1) {
          headers = cleanRow.map((c, idx) => String(c || `列${idx + 1}`));
        } else {
          rows.push(cleanRow);
        }
      });

      // 生成输出
      let result: string;
      const totalRows = rows.length;
      const totalCols = headers.length;

      if (format === 'json') {
        const jsonData = rows.map(row => {
          const obj: Record<string, unknown> = {};
          headers.forEach((header, idx) => {
            obj[header] = row[idx] ?? '';
          });
          return obj;
        });
        result = JSON.stringify(jsonData, null, 2);
      } else if (format === 'csv') {
        const csvLines = [headers.join(',')];
        rows.forEach(row => {
          const csvRow = row.map(cell => {
            const str = String(cell ?? '');
            // 如果包含逗号或引号，需要加引号
            if (str.includes(',') || str.includes('"') || str.includes('\n')) {
              return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
          });
          csvLines.push(csvRow.join(','));
        });
        result = csvLines.join('\n');
      } else {
        // Markdown table
        const headerRow = `| ${headers.join(' | ')} |`;
        const separator = `| ${headers.map(() => '---').join(' | ')} |`;
        const dataRows = rows.map(row => `| ${row.map(c => String(c ?? '')).join(' | ')} |`);
        result = [headerRow, separator, ...dataRows].join('\n');
      }

      // 工作表列表
      const sheetList = workbook.worksheets.map(ws => ws.name);

      logger.info('XLSX read', { path: absPath, sheet: worksheet.name, rows: totalRows });

      let output = `📊 Excel 内容 (${path.basename(absPath)})\n`;
      output += `工作表: ${worksheet.name} | 行数: ${totalRows} | 列数: ${totalCols}\n`;
      output += `可用工作表: ${sheetList.join(', ')}\n`;
      output += `${'─'.repeat(50)}\n\n`;
      output += result;

      if (totalRows >= max_rows) {
        output += `\n\n⚠️ 已达到最大行数限制 (${max_rows})，使用 max_rows 参数调整`;
      }

      return {
        success: true,
        output,
        metadata: {
          filePath: absPath,
          sheetName: worksheet.name,
          availableSheets: sheetList,
          rowCount: totalRows,
          columnCount: totalCols,
          format,
        },
      };
    } catch (error: any) {
      logger.error('XLSX read failed', { error: error.message });
      return {
        success: false,
        error: `Excel 读取失败: ${error.message}`,
      };
    }
  },
};
