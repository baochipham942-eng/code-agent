// ============================================================================
// xlwings_execute (P1 Wave 4 D2b — network/document_generation: native ToolModule)
//
// 把 legacy XlwingsExecuteTool 的 7-action dispatcher（check / get_active /
// list_sheets / read / write / run_macro / create_chart）整体迁移到 native。
// 通过 executePythonScript('xlwings_bridge.py', ...) 调用 Python 端 xlwings COM bridge。
//
// 平台说明：xlwings COM bridge 仅在装有 Microsoft Excel 的 Windows / macOS 上可用。
// 单测通过 mock executePythonScript 跑，不依赖真实 Excel 进程。
//
// 行为保真：legacy 输出文案（emoji 📊 📁 📋 📐 ✅ 📤 📈）和 metadata 形状 1:1 复刻。
// 暴露 executeXlwingsExecute 给 modules/excel/excelAutomate dispatcher 复用。
// ============================================================================

import * as path from 'path';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { executePythonScript } from '../../utils/pythonBridge';
import { xlwingsExecuteSchema as schema } from './xlwingsExecute.schema';

type XlwingsOperation =
  | 'check'
  | 'get_active'
  | 'list_sheets'
  | 'read'
  | 'write'
  | 'run_macro'
  | 'create_chart';

const VALID_OPERATIONS: XlwingsOperation[] = [
  'check',
  'get_active',
  'list_sheets',
  'read',
  'write',
  'run_macro',
  'create_chart',
];

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

async function checkEnvironment(): Promise<{ xlwings: boolean; excel: boolean }> {
  const result = (await executePythonScript('xlwings_bridge.py', ['--check'])) as XlwingsResult;
  return {
    xlwings: (result.xlwings_available as boolean) || false,
    excel: (result.excel_available as boolean) || false,
  };
}

export async function executeXlwingsExecute(
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

  const params = args as unknown as XlwingsParams;
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
    save = true,
  } = params;

  if (typeof operation !== 'string' || !VALID_OPERATIONS.includes(operation)) {
    return {
      ok: false,
      error: `operation must be one of: ${VALID_OPERATIONS.join(', ')}`,
      code: 'INVALID_ARGS',
    };
  }

  try {
    if (operation === 'check') {
      const env = await checkEnvironment();
      if (!env.xlwings) {
        return { ok: false, error: 'xlwings 未安装。请运行: pip install xlwings' };
      }
      if (!env.excel) {
        return { ok: false, error: 'Excel 不可用。请确保已安装 Microsoft Excel。' };
      }
      onProgress?.({ stage: 'completing', percent: 100 });
      return {
        ok: true,
        output: `✅ xlwings 环境就绪！
- xlwings: 已安装
- Excel: 可用

可以开始操作 Excel 了。`,
      };
    }

    const env = await checkEnvironment();
    if (!env.xlwings || !env.excel) {
      return {
        ok: false,
        error: env.xlwings
          ? 'Excel 不可用。请确保已安装并运行 Microsoft Excel。'
          : 'xlwings 未安装。请运行: pip install xlwings',
      };
    }

    const pythonParams: Record<string, unknown> = {};
    if (file_path) {
      pythonParams.file_path = path.isAbsolute(file_path)
        ? file_path
        : path.join(ctx.workingDir, file_path);
    }
    if (sheet) pythonParams.sheet = sheet;

    switch (operation) {
      case 'get_active':
        break;
      case 'list_sheets':
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
          return { ok: false, error: '执行宏需要提供 macro_name 参数', code: 'INVALID_ARGS' };
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
    }

    const result = (await executePythonScript('xlwings_bridge.py', [
      '--operation',
      operation,
      '--params',
      JSON.stringify(pythonParams),
    ])) as XlwingsResult;

    if (!result.success) {
      ctx.logger.warn('xlwings operation failed', { operation, error: result.error });
      return { ok: false, error: result.error || '操作失败' };
    }

    let output = '';
    switch (operation) {
      case 'get_active': {
        output = `📊 当前工作簿: ${result.workbook}\n`;
        output += `📁 路径: ${result.path}\n`;
        output += `📋 活动工作表: ${result.active_sheet}\n`;
        output += `\n工作表列表:\n`;
        const sheetsInfo = result.sheets as unknown as Array<{
          name: string;
          rows: number;
          cols: number;
        }>;
        sheetsInfo.forEach((s) => {
          output += `  - ${s.name} (${s.rows} 行 × ${s.cols} 列)\n`;
        });
        break;
      }
      case 'list_sheets': {
        output = `📊 工作簿: ${result.workbook}\n`;
        output += `📋 工作表 (${result.count}):\n`;
        (result.sheets as string[]).forEach((name, i) => {
          output += `  ${i + 1}. ${name}\n`;
        });
        break;
      }
      case 'read': {
        output = `📊 读取自 ${result.workbook} - ${result.sheet}!${result.range}\n`;
        output += `📐 大小: ${result.rows} 行 × ${result.cols} 列\n\n`;
        const readData = result.data as unknown[][];
        if (readData && readData.length > 0) {
          const headers = readData[0].map((_, i) => `列${i + 1}`);
          output += `| ${headers.join(' | ')} |\n`;
          output += `| ${headers.map(() => '---').join(' | ')} |\n`;
          readData.forEach((row) => {
            const rowValues = Array.isArray(row) ? row : [row];
            output += `| ${rowValues.map((v) => String(v ?? '')).join(' | ')} |\n`;
          });
        }
        break;
      }
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

    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('xlwings operation success', { operation, workbook: result.workbook });

    return {
      ok: true,
      output,
      meta: {
        operation,
        workbook: result.workbook,
        sheet: result.sheet,
        ...result,
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.error('xlwings execute error', { error: message });
    return { ok: false, error: `xlwings 操作失败: ${message}` };
  }
}

class XlwingsExecuteHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeXlwingsExecute(args, ctx, canUseTool, onProgress);
  }
}

export const xlwingsExecuteModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new XlwingsExecuteHandler();
  },
};
