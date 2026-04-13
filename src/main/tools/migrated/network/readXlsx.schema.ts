// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const readXlsxSchema: ToolSchema = {
  name: 'read_xlsx',
  description: `Read Excel files (.xlsx, .xls) and return structured data with column names and rows.

This is the ONLY correct way to read Excel files. Do NOT use Read for .xlsx/.xls — it will return garbled binary content.

Output formats:
- table: Markdown table (default, best for quick inspection)
- json: JSON array (best for programmatic processing)
- csv: CSV format

The output always includes column names, which you should reference exactly when writing analysis scripts.`,
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
  category: 'network',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
