// ============================================================================
// DocEdit - Unified document editing tool
// ============================================================================
// Single entry point for incremental edits on Excel, PPT, and Word files.
// Auto-detects format from file extension.
// Auto-creates snapshot before editing, auto-restores on failure.
// ============================================================================

import * as path from 'path';
import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { executeExcelEdit, type ExcelEditParams } from '../excel/excelEdit';
import { executeDocxEdit, type DocxEditParams } from './docxEdit';
// NOTE: protocol modules loaded lazily to avoid a static cycle:
// protocolRegistry → migrated/index → document/wrappers → docEditTool.

type DocFormat = 'xlsx' | 'pptx' | 'docx';

const FORMAT_MAP: Record<string, DocFormat> = {
  '.xlsx': 'xlsx',
  '.xls': 'xlsx',
  '.pptx': 'pptx',
  '.docx': 'docx',
};

export const DocEditTool: Tool = {
  name: 'DocEdit',
  description: `Unified document editing tool — atomic incremental edits on Excel, PPT, and Word files.
Auto-detects format from file extension. Auto-snapshots before editing.
~80% token savings vs full-file regeneration.

## Parameters:
- file_path (required): Path to the document (.xlsx/.pptx/.docx)
- operations (required): Array of edit operations (format-specific, see below)
- dry_run: Preview changes without applying (default: false)

## Excel operations (.xlsx):
- set_cell: { action: "set_cell", sheet?: "Sheet1", cell: "B7", value: 42000, format?: { bold: true } }
- set_range: { action: "set_range", range: "A1:C2", values: [["a","b","c"],[1,2,3]] }
- set_formula: { action: "set_formula", cell: "B8", formula: "=SUM(B2:B7)" }
- insert_rows: { action: "insert_rows", after: 5, data: [["new","row"]] }
- delete_rows: { action: "delete_rows", from: 3, count: 2 }
- insert_columns / delete_columns
- set_style: { action: "set_style", range: "A1:D1", style: { bold: true, fill: "E2EFDA" } }
- rename_sheet / add_sheet / delete_sheet / set_column_width / merge_cells / auto_filter

## PPT operations (.pptx):
Use the ppt_edit tool directly (8 actions: replace_title, replace_content, replace_slide, delete_slide, insert_slide, extract_style, reorder_slides, update_notes).

## Word operations (.docx):
- replace_text: { action: "replace_text", search: "old", replace: "new", all?: true }
- replace_paragraph: { action: "replace_paragraph", index: 2, text: "new content" }
- insert_paragraph: { action: "insert_paragraph", after: 1, text: "new para", style?: "heading2" }
- delete_paragraph: { action: "delete_paragraph", index: 3, count?: 2 }
- replace_heading: { action: "replace_heading", index: 0, text: "New Title" }
- append_paragraph: { action: "append_paragraph", text: "added at end" }
- set_text_style: { action: "set_text_style", search: "important", bold: true, color: "FF0000" }`,

  requiresPermission: true,
  permissionLevel: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Path to the document (.xlsx/.pptx/.docx)',
      },
      operations: {
        type: 'array',
        description: 'Array of edit operations (format-specific)',
      },
      dry_run: {
        type: 'boolean',
        description: 'Preview changes without applying (default: false)',
      },
    },
    required: ['file_path', 'operations'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const filePath = params.file_path as string;
    const operations = params.operations as unknown[];
    const dryRun = params.dry_run as boolean | undefined;

    if (!filePath) {
      return { success: false, error: 'file_path is required' };
    }
    if (!operations || !Array.isArray(operations) || operations.length === 0) {
      return { success: false, error: 'operations must be a non-empty array' };
    }

    const ext = path.extname(filePath).toLowerCase();
    const format = FORMAT_MAP[ext];

    if (!format) {
      return {
        success: false,
        error: `Unsupported format: ${ext}. Supported: .xlsx, .pptx, .docx`,
      };
    }

    switch (format) {
      case 'xlsx':
        return executeExcelEdit(
          { file_path: filePath, operations: operations as ExcelEditParams['operations'], dry_run: dryRun } ,
          context,
        );

      case 'docx':
        return executeDocxEdit(
          { file_path: filePath, operations: operations as DocxEditParams['operations'], dry_run: dryRun },
        );

      case 'pptx': {
        // PPT edit has a different interface (single action per call).
        // Route to ppt_edit via protocol (lazy import to break static cycle).
        const { getProtocolRegistry } = await import('../protocolRegistry');
        const { executePocToolViaProtocol } = await import('../shadowAdapter');
        if (!getProtocolRegistry().has('ppt_edit')) {
          return {
            success: false,
            error: 'PPT editing requires the ppt_edit tool. Use ppt_edit directly for .pptx files.',
          };
        }
        const results: string[] = [];
        for (const op of operations) {
          const pptOp = op as Record<string, unknown>;
          const result = await executePocToolViaProtocol({
            toolName: 'ppt_edit',
            params: { file_path: filePath, ...pptOp },
            workingDirectory: context.workingDirectory,
            requestPermission: context.requestPermission,
            sessionId: (context as { sessionId?: string }).sessionId,
          });
          if (!result.success) {
            return {
              success: false,
              error: `PPT edit failed at operation ${results.length + 1}: ${result.error}`,
              metadata: { completedOps: results },
            };
          }
          results.push(result.output || 'OK');
        }
        return {
          success: true,
          output: `PPT edited (${operations.length} operations):\n${results.map((r, i) => `  ${i + 1}. ${r}`).join('\n')}`,
          outputPath: filePath,
          metadata: { operationCount: operations.length },
        };
      }

      default:
        return { success: false, error: `Unsupported format: ${format}` };
    }
  },
};
