// ============================================================================
// ExcelAutomate (Wave 2 — excel: native ToolModule)
//
// 旧版: src/host/tools/excel/excelAutomate.ts (legacy Tool dispatcher)
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - inline canUseTool 闸门 + abort 检查 + onProgress 事件
// - 错误码规范化：INVALID_ARGS / PERMISSION_DENIED / ABORTED / EXCEL_ERROR
// - 行为保真：7 个 action（read / generate / edit / automate / list_sheets /
//   get_range / validate_formulas）输出格式（中文文案、表情符号、表头）1:1 复刻
// - 直接调下游：
//   * read     → executeReadXlsx (native, modules/network/readXlsx)
//   * generate → executeExcelGenerate (native, modules/network/excelGenerate) — Wave 4 D2b 升级
//   * edit     → executeExcelEdit (legacy helper，需 legacy ctx)
//   * automate / list_sheets / get_range → executeXlwingsExecute (native,
//     modules/network/xlwingsExecute) — Wave 4 D2b 升级
//   * validate_formulas → executePythonScript('excel_recalc.py', ...)
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
import { executeReadXlsx } from '../network/readXlsx';
import { executeExcelGenerate } from '../network/excelGenerate';
import { executeXlwingsExecute } from '../network/xlwingsExecute';
import { executeExcelEdit, type ExcelEditParams } from '../../excel/excelEdit';
import { executePythonScript } from '../../utils/pythonBridge';
import { buildLegacyCtxFromProtocol, adaptLegacyResult } from '../_helpers/legacyAdapter';
import { excelAutomateSchema as schema } from './excelAutomate.schema';
import { createFileArtifact } from '../../artifacts/artifactMeta';

type ExcelAction = 'read' | 'generate' | 'edit' | 'automate' | 'list_sheets' | 'get_range' | 'validate_formulas';

const VALID_ACTIONS: ExcelAction[] = [
  'read',
  'generate',
  'edit',
  'automate',
  'list_sheets',
  'get_range',
  'validate_formulas',
];

interface FormulaErrorRow {
  cell: string;
  sheet: string;
  error_type: string;
  formula: string;
}

interface FormulaValidateResult {
  total_formulas?: number;
  total_errors?: number;
  status?: string;
  error_summary?: FormulaErrorRow[];
}

const allowAllChild: CanUseToolFn = async () => ({ allow: true });

export async function executeExcelAutomate(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const action = args.action;
  if (typeof action !== 'string') {
    return { ok: false, error: 'action must be a string', code: 'INVALID_ARGS' };
  }
  if (!VALID_ACTIONS.includes(action as ExcelAction)) {
    return {
      ok: false,
      error: `Unknown action: "${action}". Valid actions: read, generate, edit, automate, list_sheets, get_range, validate_formulas`,
      code: 'INVALID_ARGS',
    };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: `excel ${action}` });

  switch (action as ExcelAction) {
    case 'read': {
      // Delegate to native read_xlsx (modules/network/readXlsx.ts)
      if (!args.file_path) {
        return { ok: false, error: 'action "read" requires file_path parameter', code: 'INVALID_ARGS' };
      }
      const result = await executeReadXlsx(
        {
          file_path: args.file_path,
          sheet: args.sheet,
          format: args.format,
          max_rows: args.max_rows,
        },
        ctx,
        allowAllChild,
      );
      onProgress?.({ stage: 'completing', percent: 100 });
      ctx.logger.debug('ExcelAutomate done', { action, ok: result.ok });
      return result;
    }

    case 'generate': {
      // Delegate to native excel_generate (modules/network/excelGenerate.ts)
      if (!args.title || !args.data) {
        return {
          ok: false,
          error: 'action "generate" requires title and data parameters',
          code: 'INVALID_ARGS',
        };
      }
      const result = await executeExcelGenerate(
        {
          title: args.title,
          data: args.data,
          theme: args.theme,
          output_path: args.output_path,
          sheet_name: args.sheet_name,
        },
        ctx,
        allowAllChild,
      );
      onProgress?.({ stage: 'completing', percent: 100 });
      ctx.logger.debug('ExcelAutomate done', { action, ok: result.ok });
      return result;
    }

    case 'edit': {
      // Delegate to executeExcelEdit (legacy helper, takes legacy ctx)
      if (!args.file_path) {
        return {
          ok: false,
          error: 'action "edit" requires file_path parameter',
          code: 'INVALID_ARGS',
        };
      }
      if (!args.operations) {
        return {
          ok: false,
          error: 'action "edit" requires operations parameter',
          code: 'INVALID_ARGS',
        };
      }
      const legacyCtx = buildLegacyCtxFromProtocol(ctx, canUseTool);
      const legacyResult = await executeExcelEdit(
        {
          file_path: args.file_path as string,
          operations: args.operations as ExcelEditParams['operations'],
          dry_run: args.dry_run as boolean | undefined,
        },
        legacyCtx,
      );
      onProgress?.({ stage: 'completing', percent: 100 });
      ctx.logger.debug('ExcelAutomate done', { action, ok: legacyResult.success });
      const result = adaptLegacyResult(legacyResult);
      if (!result.ok) return result;
      const filePath = args.file_path as string;
      const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.workingDir, filePath);
      const artifact = args.dry_run
        ? undefined
        : await createFileArtifact(resolvedPath, schema.name, ctx, {
          kind: 'spreadsheet',
          metadata: {
            action: 'edit',
            operation: 'excel_edit',
            path: resolvedPath,
            operationCount: Array.isArray(args.operations) ? args.operations.length : undefined,
          },
        }).catch(() => undefined);
      return {
        ...result,
        meta: {
          ...(result.meta ?? {}),
          action: 'edit',
          operation: 'excel_edit',
          path: resolvedPath,
          outputPath: resolvedPath,
          operationCount: Array.isArray(args.operations) ? args.operations.length : undefined,
          dryRun: Boolean(args.dry_run),
          changedFiles: args.dry_run ? [] : [resolvedPath],
          ...(artifact ? { artifact } : {}),
        },
      };
    }

    case 'automate': {
      // Delegate to native xlwings_execute (modules/network/xlwingsExecute.ts)
      if (!args.operation) {
        return {
          ok: false,
          error: 'action "automate" requires operation parameter',
          code: 'INVALID_ARGS',
        };
      }
      const result = await executeXlwingsExecute(
        {
          operation: args.operation,
          file_path: args.file_path,
          sheet: args.sheet,
          range: args.range,
          data: args.data,
          macro_name: args.macro_name,
          macro_args: args.macro_args,
          chart_type: args.chart_type,
          chart_title: args.chart_title,
          chart_position: args.chart_position,
          save: args.save,
        },
        ctx,
        allowAllChild,
      );
      onProgress?.({ stage: 'completing', percent: 100 });
      ctx.logger.debug('ExcelAutomate done', { action, ok: result.ok });
      return result;
    }

    case 'list_sheets': {
      // Shortcut: try xlwings first (open workbook), fallback to read_xlsx metadata
      if (!args.file_path) {
        return {
          ok: false,
          error: 'action "list_sheets" requires file_path parameter',
          code: 'INVALID_ARGS',
        };
      }
      const xlResult = await executeXlwingsExecute(
        { operation: 'list_sheets', file_path: args.file_path },
        ctx,
        allowAllChild,
      );
      if (xlResult.ok) {
        onProgress?.({ stage: 'completing', percent: 100 });
        ctx.logger.debug('ExcelAutomate done', { action, ok: true });
        return xlResult;
      }
      // Fallback: use read_xlsx to derive sheet names from metadata
      const readResult = await executeReadXlsx(
        { file_path: args.file_path, max_rows: 1 },
        ctx,
        allowAllChild,
      );
      if (readResult.ok && readResult.meta && Array.isArray(readResult.meta.availableSheets)) {
        const sheets = readResult.meta.availableSheets as string[];
        onProgress?.({ stage: 'completing', percent: 100 });
        ctx.logger.debug('ExcelAutomate done', { action, ok: true });
        return {
          ok: true,
          output: `📋 工作表列表 (${sheets.length}):\n${sheets.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`,
          meta: { sheets },
        };
      }
      onProgress?.({ stage: 'completing', percent: 100 });
      ctx.logger.debug('ExcelAutomate done', { action, ok: readResult.ok });
      return readResult;
    }

    case 'get_range': {
      // Shortcut for reading a specific range via xlwings
      if (!args.range) {
        return {
          ok: false,
          error: 'action "get_range" requires range parameter',
          code: 'INVALID_ARGS',
        };
      }
      const result = await executeXlwingsExecute(
        {
          operation: 'read',
          file_path: args.file_path,
          sheet: args.sheet,
          range: args.range,
        },
        ctx,
        allowAllChild,
      );
      onProgress?.({ stage: 'completing', percent: 100 });
      ctx.logger.debug('ExcelAutomate done', { action, ok: result.ok });
      return result;
    }

    case 'validate_formulas': {
      if (!args.file_path) {
        return {
          ok: false,
          error: 'action "validate_formulas" requires file_path parameter',
          code: 'INVALID_ARGS',
        };
      }
      const filePathArg = args.file_path as string;
      const filePath = path.isAbsolute(filePathArg)
        ? filePathArg
        : path.join(ctx.workingDir, filePathArg);

      const pyArgs = ['--file', filePath];
      if (args.recalc) pyArgs.push('--recalc');

      const result = (await executePythonScript('excel_recalc.py', pyArgs)) as FormulaValidateResult & {
        success: boolean;
        error?: string;
      };
      if (!result.success) {
        onProgress?.({ stage: 'completing', percent: 100 });
        return {
          ok: false,
          error: result.error || '公式验证失败',
          code: 'EXCEL_ERROR',
        };
      }

      const errors = result.error_summary || [];
      let output = `📊 公式验证完成\n\n`;
      output += `公式总数: ${result.total_formulas}\n`;
      output += `错误数量: ${result.total_errors}\n`;
      output += `状态: ${result.status === 'clean' ? '✅ 无错误' : '⚠️ 发现错误'}\n`;

      if (errors.length > 0) {
        output += `\n错误详情:\n`;
        for (const err of errors) {
          output += `  - ${err.sheet}!${err.cell}: ${err.error_type} (${err.formula})\n`;
        }
      }

      onProgress?.({ stage: 'completing', percent: 100 });
      ctx.logger.debug('ExcelAutomate done', { action, ok: true });
      return {
        ok: true,
        output,
        meta: result as unknown as Record<string, unknown>,
      };
    }
  }
}

class ExcelAutomateHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeExcelAutomate(args, ctx, canUseTool, onProgress);
  }
}

export const excelAutomateModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ExcelAutomateHandler();
  },
};
