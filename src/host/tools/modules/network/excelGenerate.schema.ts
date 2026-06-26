// Schema-only file (P0-7 方案 A — single source of truth)
// excel_generate — 字段与 legacy inputSchema 1:1 复刻
import type { ToolSchema } from '../../../protocol/tools';

export const excelGenerateSchema: ToolSchema = {
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
        enum: ['professional', 'colorful', 'minimal', 'dark', 'financial'],
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
  category: 'network',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
