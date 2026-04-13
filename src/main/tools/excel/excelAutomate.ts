// ============================================================================
// ExcelAutomate - Unified Excel automation tool
// ============================================================================
// Merges excel_generate, read_xlsx, and xlwings_execute into a single tool
// with an `action` parameter dispatching to the original implementations.
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import * as path from 'path';
import { excelGenerateTool } from '../network/excelGenerate';
import { executeReadXlsx } from '../migrated/network/readXlsx';
import { invokeNativeFromLegacy } from '../migrated/_helpers/invokeNativeFromLegacy';
import { xlwingsExecuteTool } from '../network/xlwingsExecute';
import { executeExcelEdit } from './excelEdit';
import { executePythonScript } from '../utils/pythonBridge';

type ExcelAction = 'read' | 'generate' | 'edit' | 'automate' | 'list_sheets' | 'get_range' | 'validate_formulas';

export const ExcelAutomateTool: Tool = {
  name: 'ExcelAutomate',
  description: `Unified Excel automation tool combining reading, generating, and live automation.

## Actions:

### read — Read Excel file contents
Reads .xlsx/.xls files and returns structured data (Markdown table, JSON, or CSV).
This is the ONLY correct way to read Excel files — do NOT use Read for .xlsx/.xls.

Parameters:
- file_path (required): Excel file path
- sheet: Sheet name or index (default: first sheet)
- format: Output format — "table" | "json" | "csv" (default: table)
- max_rows: Max rows to read (default: 1000)

### generate — Generate a new Excel file
Creates a styled .xlsx file from various input formats (JSON array, Markdown table, CSV, TSV).

Parameters:
- title (required): Spreadsheet title / filename
- data (required): Table data (JSON array, Markdown table, CSV, or TSV string)
- theme: "professional" | "colorful" | "minimal" | "dark" (default: professional)
- output_path: Output file path (default: working directory)
- sheet_name: Worksheet name (default: Sheet1)

### edit — Atomic edits on an existing Excel file
Performs incremental cell/row/column level edits instead of regenerating the entire file.
Auto-creates a backup snapshot before editing. ~80% less tokens than regeneration.

Parameters:
- file_path (required): Path to the existing .xlsx file
- operations (required): JSON array of edit operations
- dry_run: Preview changes without applying (default: false)

**Available operations:**
- set_cell: { action: "set_cell", sheet?: "Sheet1", cell: "B7", value: 42000, format?: { bold: true } }
- set_range: { action: "set_range", range: "A1:C2", values: [["a","b","c"],[1,2,3]] }
- set_formula: { action: "set_formula", cell: "B8", formula: "=SUM(B2:B7)" }
- insert_rows: { action: "insert_rows", after: 5, data: [["new","row"]] }
- delete_rows: { action: "delete_rows", from: 3, count: 2 }
- insert_columns: { action: "insert_columns", after: "C", headers: ["New Col"] }
- delete_columns: { action: "delete_columns", from: "D", count: 1 }
- set_style: { action: "set_style", range: "A1:D1", style: { bold: true, fill: "E2EFDA" } }
- rename_sheet: { action: "rename_sheet", sheet: "Sheet1", newName: "Sales" }
- add_sheet: { action: "add_sheet", name: "Q2" }
- delete_sheet: { action: "delete_sheet", sheet: "Temp" }
- set_column_width: { action: "set_column_width", column: "A", width: 20 }
- merge_cells: { action: "merge_cells", range: "A1:D1" }
- auto_filter: { action: "auto_filter", range: "A1:D100" }

**Format options for set_cell/set_style:** bold, italic, fontSize, fontColor (hex), fill (hex), numberFormat, alignment, border

### automate — Live Excel automation via xlwings
Operates on the currently open Excel workbook. Requires Excel app + xlwings installed.

Parameters:
- operation (required): "check" | "get_active" | "read" | "write" | "run_macro" | "create_chart"
- file_path: Excel file path (optional, defaults to active workbook)
- sheet: Sheet name
- range: Cell range (e.g. "A1:D10")
- data: Data to write (2D array)
- macro_name: VBA macro name (for run_macro)
- macro_args: Macro arguments
- chart_type: "line" | "bar" | "column" | "pie" | "scatter" | "area"
- chart_title: Chart title
- chart_position: Chart position (e.g. "E1")
- save: Save after write (default: true)

### list_sheets — List all sheets in an Excel file
Shortcut for listing worksheet names. Uses xlwings if Excel is open, otherwise reads file directly.

Parameters:
- file_path (required): Excel file path

### get_range — Read a specific cell range
Shortcut for reading a specific range from an open workbook via xlwings.

Parameters:
- file_path: Excel file path (optional, defaults to active workbook)
- sheet: Sheet name
- range (required): Cell range (e.g. "A1:D10")

### validate_formulas — Validate formulas in an Excel file
Scans for formula errors (#REF!, #DIV/0!, #VALUE!, #N/A, #NAME?, #NULL!, #NUM!).
Optionally recalculates with LibreOffice first.

Parameters:
- file_path (required): Excel file path
- recalc: Recalculate with LibreOffice before scanning (default: false)`,
  requiresPermission: true,
  permissionLevel: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['read', 'generate', 'edit', 'automate', 'list_sheets', 'get_range', 'validate_formulas'],
        description: 'The Excel action to perform',
      },
      // --- edit params ---
      operations: {
        type: 'array',
        description: '[edit] Array of edit operations (set_cell, set_range, set_formula, insert_rows, delete_rows, etc.)',
      },
      dry_run: {
        type: 'boolean',
        description: '[edit] Preview changes without applying (default: false)',
      },
      // --- read params ---
      file_path: {
        type: 'string',
        description: '[read/generate/automate/list_sheets/get_range] Excel file path',
      },
      sheet: {
        type: 'string',
        description: '[read/automate/get_range] Sheet name or index',
      },
      format: {
        type: 'string',
        enum: ['table', 'json', 'csv'],
        description: '[read] Output format (default: table)',
      },
      max_rows: {
        type: 'number',
        description: '[read] Max rows to read (default: 1000)',
      },
      // --- generate params ---
      title: {
        type: 'string',
        description: '[generate] Spreadsheet title / filename',
      },
      data: {
        type: 'string',
        description: '[generate] Table data (JSON array, Markdown table, CSV, or TSV); [automate/write] Data to write (2D array)',
      },
      theme: {
        type: 'string',
        enum: ['professional', 'colorful', 'minimal', 'dark', 'financial'],
        description: '[generate] Theme style (default: professional)',
      },
      output_path: {
        type: 'string',
        description: '[generate] Output file path',
      },
      sheet_name: {
        type: 'string',
        description: '[generate] Worksheet name (default: Sheet1)',
      },
      // --- automate params ---
      operation: {
        type: 'string',
        enum: ['check', 'get_active', 'read', 'write', 'run_macro', 'create_chart'],
        description: '[automate] xlwings operation type',
      },
      range: {
        type: 'string',
        description: '[automate/get_range] Cell range (e.g. A1:D10)',
      },
      macro_name: {
        type: 'string',
        description: '[automate] VBA macro name',
      },
      macro_args: {
        type: 'array',
        description: '[automate] Macro arguments',
      },
      chart_type: {
        type: 'string',
        enum: ['line', 'bar', 'column', 'pie', 'scatter', 'area'],
        description: '[automate] Chart type',
      },
      chart_title: {
        type: 'string',
        description: '[automate] Chart title',
      },
      chart_position: {
        type: 'string',
        description: '[automate] Chart position (e.g. E1)',
      },
      save: {
        type: 'boolean',
        description: '[automate] Save after write (default: true)',
      },
    },
    required: ['action'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const action = params.action as ExcelAction;

    switch (action) {
      case 'read': {
        // Delegate to native read_xlsx (migrated/network/readXlsx.ts)
        if (!params.file_path) {
          return { success: false, error: 'action "read" requires file_path parameter' };
        }
        return invokeNativeFromLegacy(
          executeReadXlsx,
          { file_path: params.file_path, sheet: params.sheet, format: params.format, max_rows: params.max_rows },
          context,
          'excel-automate-delegate',
        );
      }

      case 'generate': {
        // Delegate to excelGenerateTool
        if (!params.title || !params.data) {
          return { success: false, error: 'action "generate" requires title and data parameters' };
        }
        return excelGenerateTool.execute(
          { title: params.title, data: params.data, theme: params.theme, output_path: params.output_path, sheet_name: params.sheet_name },
          context
        );
      }

      case 'edit': {
        // Delegate to excelEdit
        if (!params.file_path) {
          return { success: false, error: 'action "edit" requires file_path parameter' };
        }
        if (!params.operations) {
          return { success: false, error: 'action "edit" requires operations parameter' };
        }
        return executeExcelEdit(
          {
            file_path: params.file_path as string,
            operations: params.operations as import('./excelEdit').ExcelEditParams['operations'],
            dry_run: params.dry_run as boolean | undefined,
          },
          context,
        );
      }

      case 'automate': {
        // Delegate to xlwingsExecuteTool
        if (!params.operation) {
          return { success: false, error: 'action "automate" requires operation parameter' };
        }
        return xlwingsExecuteTool.execute(
          {
            operation: params.operation,
            file_path: params.file_path,
            sheet: params.sheet,
            range: params.range,
            data: params.data,
            macro_name: params.macro_name,
            macro_args: params.macro_args,
            chart_type: params.chart_type,
            chart_title: params.chart_title,
            chart_position: params.chart_position,
            save: params.save,
          },
          context
        );
      }

      case 'list_sheets': {
        // Shortcut: try xlwings first (for open workbooks), fallback to read_xlsx
        if (!params.file_path) {
          return { success: false, error: 'action "list_sheets" requires file_path parameter' };
        }
        // Try xlwings list_sheets
        const xlResult = await xlwingsExecuteTool.execute(
          { operation: 'list_sheets', file_path: params.file_path },
          context
        );
        if (xlResult.success) {
          return xlResult;
        }
        // Fallback: use read_xlsx to get sheet names (reads first sheet but returns sheet list in metadata)
        const readResult = await invokeNativeFromLegacy(
          executeReadXlsx,
          { file_path: params.file_path, max_rows: 1 },
          context,
          'excel-automate-delegate',
        );
        if (readResult.success && readResult.metadata?.availableSheets) {
          const sheets = readResult.metadata.availableSheets as string[];
          return {
            success: true,
            output: `📋 工作表列表 (${sheets.length}):\n${sheets.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`,
            metadata: { sheets },
          };
        }
        return readResult;
      }

      case 'get_range': {
        // Shortcut for reading a specific range via xlwings
        if (!params.range) {
          return { success: false, error: 'action "get_range" requires range parameter' };
        }
        return xlwingsExecuteTool.execute(
          { operation: 'read', file_path: params.file_path, sheet: params.sheet, range: params.range },
          context
        );
      }

      case 'validate_formulas': {
        if (!params.file_path) {
          return { success: false, error: 'action "validate_formulas" requires file_path parameter' };
        }
        const filePath = path.isAbsolute(params.file_path as string)
          ? params.file_path as string
          : path.join(context.workingDirectory, params.file_path as string);

        const args = ['--file', filePath];
        if (params.recalc) args.push('--recalc');

        const result = await executePythonScript('excel_recalc.py', args);
        if (!result.success) {
          return { success: false, error: result.error || '公式验证失败' };
        }

        const errors = result.error_summary as Array<{ cell: string; sheet: string; error_type: string; formula: string }> || [];
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

        return {
          success: true,
          output,
          metadata: result,
        };
      }

      default:
        return {
          success: false,
          error: `Unknown action: "${action}". Valid actions: read, generate, edit, automate, list_sheets, get_range, validate_formulas`,
        };
    }
  },
};
