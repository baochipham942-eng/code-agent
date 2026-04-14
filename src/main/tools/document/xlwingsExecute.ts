// ============================================================================
// xlwings Execute Tool - Excel 自动化（通过 xlwings）
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import * as path from 'path';
import { createLogger } from '../../services/infra/logger';
import { executePythonScript } from '../utils/pythonBridge';

const logger = createLogger('XlwingsExecute');

type XlwingsOperation = 'read' | 'write' | 'run_macro' | 'get_active' | 'list_sheets' | 'create_chart' | 'check';

interface XlwingsParams {
  operation: XlwingsOperation;
  file_path?: string;
  sheet?: string;
  range?: string;
  data?: unknown;
  macro_name?: string;
  macro_args?: unknown[];
  chart_type?: 'line' | 'bar' | 'column' | 'pie' | 'scatter' | 'area';
  chart_title?: string;
  chart_position?: string;
  save?: boolean;
}

interface XlwingsResult {
  success: boolean;
  error?: string;
  data?: unknown;
  message?: string;
  workbook?: string;
  sheet?: string;
  sheets?: string[];
  [key: string]: unknown;
}

/**
 * 执行 xlwings Python 脚本（委派给 pythonBridge）
 */
async function executePython(args: string[]): Promise<XlwingsResult> {
  return executePythonScript('xlwings_bridge.py', args) as Promise<XlwingsResult>;
}

/**
 * 检查 xlwings 环境
 */
async function checkEnvironment(): Promise<{ xlwings: boolean; excel: boolean }> {
  const result = await executePython(['--check']);
  return {
    xlwings: result.xlwings_available as boolean || false,
    excel: result.excel_available as boolean || false
  };
}

export const xlwingsExecuteTool: Tool = {
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
  requiresPermission: true,
  permissionLevel: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['check', 'get_active', 'list_sheets', 'read', 'write', 'run_macro', 'create_chart'],
        description: '操作类型'
      },
      file_path: {
        type: 'string',
        description: 'Excel 文件路径（可选，不指定则操作当前活动工作簿）'
      },
      sheet: {
        type: 'string',
        description: '工作表名称（可选，默认当前活动工作表）'
      },
      range: {
        type: 'string',
        description: '单元格范围（如 A1、A1:D10）'
      },
      data: {
        type: 'array',
        description: '要写入的数据（二维数组或单个值）'
      },
      macro_name: {
        type: 'string',
        description: 'VBA 宏名称'
      },
      macro_args: {
        type: 'array',
        description: '宏参数列表'
      },
      chart_type: {
        type: 'string',
        enum: ['line', 'bar', 'column', 'pie', 'scatter', 'area'],
        description: '图表类型'
      },
      chart_title: {
        type: 'string',
        description: '图表标题'
      },
      chart_position: {
        type: 'string',
        description: '图表位置（如 E1）'
      },
      save: {
        type: 'boolean',
        description: '写入后是否保存（默认 true）',
        default: true
      }
    },
    required: ['operation']
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const {
      operation,
      file_path,
      sheet,
      range,
      data,
      macro_name,
      macro_args,
      chart_type,
      chart_title,
      chart_position,
      save = true
    } = params as unknown as XlwingsParams;

    try {
      // 检查环境
      if (operation === 'check') {
        context.emit?.('tool_output', {
          tool: 'xlwings_execute',
          message: '🔍 正在检查 xlwings 环境...'
        });

        const env = await checkEnvironment();

        if (!env.xlwings) {
          return {
            success: false,
            error: 'xlwings 未安装。请运行: pip install xlwings'
          };
        }

        if (!env.excel) {
          return {
            success: false,
            error: 'Excel 不可用。请确保已安装 Microsoft Excel。'
          };
        }

        return {
          success: true,
          output: `✅ xlwings 环境就绪！
- xlwings: 已安装
- Excel: 可用

可以开始操作 Excel 了。`
        };
      }

      // 先检查环境
      const env = await checkEnvironment();
      if (!env.xlwings || !env.excel) {
        return {
          success: false,
          error: env.xlwings
            ? 'Excel 不可用。请确保已安装并运行 Microsoft Excel。'
            : 'xlwings 未安装。请运行: pip install xlwings'
        };
      }

      // 构建参数
      const pythonParams: Record<string, unknown> = {};

      if (file_path) {
        pythonParams.file_path = path.isAbsolute(file_path)
          ? file_path
          : path.join(context.workingDirectory, file_path);
      }

      if (sheet) pythonParams.sheet = sheet;

      // 根据操作类型设置参数
      switch (operation) {
        case 'get_active':
          // 无额外参数
          break;

        case 'list_sheets':
          // file_path 已处理
          break;

        case 'read':
          pythonParams.range_addr = range || 'A1';
          break;

        case 'write':
          pythonParams.range_addr = range || 'A1';
          pythonParams.data = data;
          pythonParams.save = save;
          break;

        case 'run_macro':
          if (!macro_name) {
            return {
              success: false,
              error: '执行宏需要提供 macro_name 参数'
            };
          }
          pythonParams.macro_name = macro_name;
          if (macro_args) pythonParams.args = macro_args;
          break;

        case 'create_chart':
          pythonParams.data_range = range || 'A1:B10';
          pythonParams.chart_type = chart_type || 'line';
          if (chart_title) pythonParams.title = chart_title;
          pythonParams.position = chart_position || 'E1';
          break;

        default:
          return {
            success: false,
            error: `未知操作: ${operation}`
          };
      }

      context.emit?.('tool_output', {
        tool: 'xlwings_execute',
        message: `📊 正在执行 ${operation}...`
      });

      // 执行操作
      const result = await executePython([
        '--operation', operation,
        '--params', JSON.stringify(pythonParams)
      ]);

      if (!result.success) {
        logger.error('xlwings operation failed', { operation, error: result.error });
        return {
          success: false,
          error: result.error || '操作失败'
        };
      }

      // 格式化输出
      let output = '';

      switch (operation) {
        case 'get_active':
          output = `📊 当前工作簿: ${result.workbook}\n`;
          output += `📁 路径: ${result.path}\n`;
          output += `📋 活动工作表: ${result.active_sheet}\n`;
          output += `\n工作表列表:\n`;
          const sheetsInfo = result.sheets as unknown as Array<{ name: string; rows: number; cols: number }>;
          sheetsInfo.forEach((s) => {
            output += `  - ${s.name} (${s.rows} 行 × ${s.cols} 列)\n`;
          });
          break;

        case 'list_sheets':
          output = `📊 工作簿: ${result.workbook}\n`;
          output += `📋 工作表 (${result.count}):\n`;
          (result.sheets as string[]).forEach((name, i) => {
            output += `  ${i + 1}. ${name}\n`;
          });
          break;

        case 'read':
          output = `📊 读取自 ${result.workbook} - ${result.sheet}!${result.range}\n`;
          output += `📐 大小: ${result.rows} 行 × ${result.cols} 列\n\n`;

          // 格式化数据为表格
          const readData = result.data as unknown[][];
          if (readData && readData.length > 0) {
            // Markdown 表格
            const headers = readData[0].map((_, i) => `列${i + 1}`);
            output += `| ${headers.join(' | ')} |\n`;
            output += `| ${headers.map(() => '---').join(' | ')} |\n`;
            readData.forEach(row => {
              const rowValues = Array.isArray(row) ? row : [row];
              output += `| ${rowValues.map(v => String(v ?? '')).join(' | ')} |\n`;
            });
          }
          break;

        case 'write':
          output = `✅ ${result.message}\n`;
          output += `📊 工作簿: ${result.workbook}\n`;
          output += `📋 工作表: ${result.sheet}`;
          break;

        case 'run_macro':
          output = `✅ ${result.message}\n`;
          output += `📊 工作簿: ${result.workbook}\n`;
          if (result.return_value !== undefined && result.return_value !== null) {
            output += `📤 返回值: ${JSON.stringify(result.return_value)}`;
          }
          break;

        case 'create_chart':
          output = `✅ ${result.message}\n`;
          output += `📊 图表类型: ${result.chart_type}\n`;
          output += `📈 数据范围: ${result.data_range}`;
          break;
      }

      logger.info('xlwings operation success', { operation, workbook: result.workbook });

      return {
        success: true,
        output,
        metadata: {
          operation,
          workbook: result.workbook,
          sheet: result.sheet,
          ...result
        }
      };

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('xlwings execute error', { error: errorMessage });
      return {
        success: false,
        error: `xlwings 操作失败: ${errorMessage}`
      };
    }
  }
};
