// Schema-only file (P0-7 方案 A — single source of truth)
// xlwings_execute — 字段与 legacy inputSchema 1:1 复刻
import type { ToolSchema } from '../../../protocol/tools';

export const xlwingsExecuteSchema: ToolSchema = {
  name: 'xlwings_execute',
  description: `通过 xlwings 操作 Excel（需要安装 Excel 应用程序）。

**独特能力**：
- 操作用户当前打开的 Excel 工作簿（实时交互）
- 执行 VBA 宏
- 保留原有格式和公式
- 创建图表

**操作类型**：
- \`check\`: 检查环境是否可用
- \`get_active\`: 获取当前活动工作簿信息
- \`list_sheets\`: 列出工作表
- \`read\`: 读取单元格/范围
- \`write\`: 写入单元格/范围
- \`run_macro\`: 执行 VBA 宏
- \`create_chart\`: 创建图表

**使用示例**：
\`\`\`
xlwings_execute { "operation": "check" }
xlwings_execute { "operation": "get_active" }
xlwings_execute { "operation": "read", "range": "A1:D10" }
xlwings_execute { "operation": "read", "file_path": "data.xlsx", "sheet": "Sheet1", "range": "A1:B5" }
xlwings_execute { "operation": "write", "range": "A1", "data": [["Name", "Age"], ["Alice", 25], ["Bob", 30]] }
xlwings_execute { "operation": "run_macro", "macro_name": "MyMacro" }
xlwings_execute { "operation": "create_chart", "range": "A1:B10", "chart_type": "line", "chart_title": "Sales" }
\`\`\`

**注意**：需要安装 Python 和 xlwings（\`pip install xlwings\`），以及 Excel 应用程序。`,
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['check', 'get_active', 'list_sheets', 'read', 'write', 'run_macro', 'create_chart'],
        description: '操作类型',
      },
      file_path: {
        type: 'string',
        description: 'Excel 文件路径（可选，不指定则操作当前活动工作簿）',
      },
      sheet: {
        type: 'string',
        description: '工作表名称（可选，默认当前活动工作表）',
      },
      range: {
        type: 'string',
        description: '单元格范围（如 A1、A1:D10）',
      },
      data: {
        type: 'array',
        description: '要写入的数据（二维数组或单个值）',
      },
      macro_name: {
        type: 'string',
        description: 'VBA 宏名称',
      },
      macro_args: {
        type: 'array',
        description: '宏参数列表',
      },
      chart_type: {
        type: 'string',
        enum: ['line', 'bar', 'column', 'pie', 'scatter', 'area'],
        description: '图表类型',
      },
      chart_title: {
        type: 'string',
        description: '图表标题',
      },
      chart_position: {
        type: 'string',
        description: '图表位置（如 E1）',
      },
      save: {
        type: 'boolean',
        description: '写入后是否保存（默认 true）',
        default: true,
      },
    },
    required: ['operation'],
  },
  category: 'network',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
