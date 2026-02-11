// ============================================================================
// Read XLSX Tool - 读取 Excel 表格内容
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import * as fs from 'fs';
import * as path from 'path';
import ExcelJS from 'exceljs';
import { execSync } from 'child_process';
import { createLogger } from '../../services/infra/logger';
import { dataFingerprintStore } from '../dataFingerprint';

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

      // 数据质量分析 + 指纹记录
      const qualitySummary = analyzeDataQuality(rows, headers);

      // 记录数据指纹，用于 compaction recovery 时的源数据锚定
      if (rows.length > 0 && headers.length > 0) {
        const sampleValues: Record<string, string> = {};
        headers.forEach((h, idx) => {
          if (rows[0][idx] !== null && rows[0][idx] !== undefined && rows[0][idx] !== '') {
            sampleValues[h] = String(rows[0][idx]);
          }
        });

        const numericRanges: Record<string, { min: number; max: number }> = {};
        headers.forEach((h, idx) => {
          const numericValues = rows
            .map(row => row[idx])
            .filter((v): v is number => typeof v === 'number' && !isNaN(v));
          if (numericValues.length > 0) {
            numericRanges[h] = {
              min: Math.min(...numericValues),
              max: Math.max(...numericValues),
            };
          }
        });

        dataFingerprintStore.record({
          filePath: absPath,
          readTime: Date.now(),
          sheetName: worksheet.name,
          rowCount: totalRows,
          columnNames: headers,
          sampleValues,
          numericRanges: Object.keys(numericRanges).length > 0 ? numericRanges : undefined,
          categoricalValues: Object.keys(qualitySummary.categoricalValues).length > 0 ? qualitySummary.categoricalValues : undefined,
          nullCounts: Object.keys(qualitySummary.nullCounts).length > 0 ? qualitySummary.nullCounts : undefined,
          duplicateRowCount: qualitySummary.duplicateRowCount > 0 ? qualitySummary.duplicateRowCount : undefined,
        });
      }

      let output = `📊 Excel 内容 (${path.basename(absPath)})\n`;
      output += `工作表: ${worksheet.name} | 行数: ${totalRows} | 列数: ${totalCols}\n`;
      output += `可用工作表: ${sheetList.join(', ')}\n`;
      output += `${'─'.repeat(50)}\n\n`;
      output += result;

      // 数据质量摘要（自动附加，模型可据此决策）
      if (qualitySummary.hasIssues) {
        output += `\n\n📋 数据质量摘要:\n`;
        for (const line of qualitySummary.lines) {
          output += `${line}\n`;
        }
      }

      output += `\n\n⚠️ 数据处理注意:\n`;
      output += `- 去重: drop_duplicates(subset=['主键列'])，不要全列去重误删合法数据\n`;
      output += `- 阶梯累进: 提成/税率必须分段累加，不能按最高档全额计算\n`;
      output += `- 日期统一: pd.to_datetime(col, format='mixed').dt.strftime('%Y-%m-%d')`;

      output += `\n\n💡 提示：完整数据请用 bash + Python 读取源文件：pd.read_excel('${absPath}', sheet_name='${worksheet.name}')`;

      if (totalRows >= max_rows) {
        output += `\n⚠️ 已达到最大行数限制 (${max_rows})，使用 max_rows 参数调整`;
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
      // Chart fallback: ExcelJS 在含图表的 xlsx 上会崩溃（anchors 等错误）
      // 回退到 Python pandas 读取
      if (error.message?.includes('anchors') || error.message?.includes('Cannot read properties of undefined')) {
        logger.warn(`[ReadXlsx] ExcelJS failed (${error.message}), trying Python pandas fallback`);
        try {
          const absPath = path.isAbsolute(file_path)
            ? file_path
            : path.join(context.workingDirectory, file_path);
          const sheetArg = sheet !== undefined ? `, sheet_name='${sheet}'` : '';
          const pyScript = `import pandas as pd; df = pd.read_excel('${absPath}'${sheetArg}); print(f'ROWS:{len(df)}'); print(f'COLS:{",".join(df.columns.tolist())}'); print('---DATA---'); print(df.head(${max_rows}).to_csv(index=False))`;
          const pyResult = execSync(`python3 -c "${pyScript.replace(/"/g, '\\"')}"`, {
            timeout: 30000,
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024,
          });

          const rowMatch = pyResult.match(/ROWS:(\d+)/);
          const colMatch = pyResult.match(/COLS:(.+)/);
          const dataStart = pyResult.indexOf('---DATA---');
          const csvData = dataStart >= 0 ? pyResult.substring(dataStart + 10).trim() : pyResult;

          const totalRows = rowMatch ? parseInt(rowMatch[1]) : 0;
          const columnNames = colMatch ? colMatch[1].split(',') : [];

          return {
            success: true,
            output: `📊 Excel 内容 (${path.basename(absPath)}) [pandas fallback - 原文件含图表]\n` +
              `行数: ${totalRows} | 列数: ${columnNames.length}\n` +
              `${'─'.repeat(50)}\n\n${csvData}` +
              `\n\n💡 提示：此文件含图表，ExcelJS 无法解析，已通过 pandas 读取。`,
            metadata: {
              filePath: absPath,
              rowCount: totalRows,
              columnCount: columnNames.length,
              format: 'csv',
              fallback: 'pandas',
            },
          };
        } catch (pyError: any) {
          logger.error('Python pandas fallback also failed', { error: pyError.message });
        }
      }

      logger.error('XLSX read failed', { error: error.message });
      return {
        success: false,
        error: `Excel 读取失败: ${error.message}`,
      };
    }
  },
};

// ─── 数据质量分析 ───────────────────────────────────────────────

interface QualitySummary {
  hasIssues: boolean;
  lines: string[];
  nullCounts: Record<string, number>;
  categoricalValues: Record<string, string[]>;
  duplicateRowCount: number;
}

type CellValue = string | number | boolean | null;

function analyzeDataQuality(rows: CellValue[][], headers: string[]): QualitySummary {
  const lines: string[] = [];
  const nullCounts: Record<string, number> = {};
  const categoricalValues: Record<string, string[]> = {};
  let duplicateRowCount = 0;

  if (rows.length === 0 || headers.length === 0) {
    return { hasIssues: false, lines, nullCounts, categoricalValues, duplicateRowCount };
  }

  // 1. 空值统计
  const colsWithNulls: string[] = [];
  headers.forEach((h, idx) => {
    const nullCount = rows.filter(r => r[idx] === null || r[idx] === undefined || r[idx] === '').length;
    if (nullCount > 0) {
      nullCounts[h] = nullCount;
      colsWithNulls.push(`${h}(${nullCount})`);
    }
  });
  if (colsWithNulls.length > 0) {
    lines.push(`- 空值: ${colsWithNulls.slice(0, 8).join(', ')}${colsWithNulls.length > 8 ? ` ...共${colsWithNulls.length}列` : ''}`);
  }

  // 2. 重复行检测（抽样: 用前 5000 行检查，避免大数据集性能问题）
  const checkRows = rows.slice(0, 5000);
  const seen = new Set<string>();
  let dupes = 0;
  for (const row of checkRows) {
    const key = row.map(c => String(c ?? '')).join('\t');
    if (seen.has(key)) {
      dupes++;
    } else {
      seen.add(key);
    }
  }
  duplicateRowCount = dupes;
  if (dupes > 0) {
    lines.push(`- 完全重复行: ${dupes}${rows.length > 5000 ? ` (前5000行采样)` : ''}`);
  }

  // 3. 分类值枚举（低基数列 ≤ 20 unique values）
  const catCols: string[] = [];
  headers.forEach((h, idx) => {
    const uniqueVals = new Set<string>();
    let isLowCardinality = true;
    for (const row of rows) {
      const val = row[idx];
      if (val !== null && val !== undefined && val !== '') {
        uniqueVals.add(String(val));
        if (uniqueVals.size > 20) {
          isLowCardinality = false;
          break;
        }
      }
    }
    if (isLowCardinality && uniqueVals.size >= 2 && uniqueVals.size <= 20) {
      const vals = Array.from(uniqueVals).sort();
      categoricalValues[h] = vals;
      catCols.push(`${h}(${vals.length}种: ${vals.slice(0, 6).join('/')})${vals.length > 6 ? '...' : ''}`);
    }
  });
  if (catCols.length > 0) {
    lines.push(`- 分类列: ${catCols.slice(0, 5).join('; ')}${catCols.length > 5 ? ` ...共${catCols.length}列` : ''}`);
  }

  return {
    hasIssues: lines.length > 0,
    lines,
    nullCounts,
    categoricalValues,
    duplicateRowCount,
  };
}
