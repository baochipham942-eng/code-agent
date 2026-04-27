// ============================================================================
// DocEdit (P0-6.3 Batch 7 — document: native ToolModule rewrite)
//
// 统一文档编辑入口：.xlsx/.pptx/.docx 按后缀自动分派
// - xlsx → executeExcelEdit (legacy helper, 需要 legacy ctx)
// - docx → executeDocxEdit (legacy helper, 仅 params)
// - pptx → 通过 ctx.resolver 派发到 ppt_edit (legacy ctx)
// ============================================================================

import * as path from 'path';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
  ToolSchema,
} from '../../../protocol/tools';
import type { ToolResolver } from '../../../tools/dispatch/toolResolver';
import { executeExcelEdit, type ExcelEditParams } from '../../excel/excelEdit';
import { executeDocxEdit, type DocxEditParams } from '../../document/docxEdit';
import { buildLegacyCtxFromProtocol } from '../_helpers/legacyAdapter';

type DocFormat = 'xlsx' | 'pptx' | 'docx';

const FORMAT_MAP: Record<string, DocFormat> = {
  '.xlsx': 'xlsx',
  '.xls': 'xlsx',
  '.pptx': 'pptx',
  '.docx': 'docx',
};

const schema: ToolSchema = {
  name: 'DocEdit',
  description: `Unified document editing tool — atomic incremental edits on Excel, PPT, and Word files.
Auto-detects format from file extension (.xlsx/.xls/.pptx/.docx). Auto-snapshots before editing.
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
  category: 'document',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};

async function executeDocEdit(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const filePath = args.file_path;
  const operations = args.operations;
  const dryRun = args.dry_run as boolean | undefined;

  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { ok: false, error: 'file_path is required', code: 'INVALID_ARGS' };
  }
  if (!Array.isArray(operations) || operations.length === 0) {
    return { ok: false, error: 'operations must be a non-empty array', code: 'INVALID_ARGS' };
  }

  const ext = path.extname(filePath).toLowerCase();
  const format = FORMAT_MAP[ext];
  if (!format) {
    return {
      ok: false,
      error: `Unsupported format: ${ext}. Supported: .xlsx, .pptx, .docx`,
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

  onProgress?.({ stage: 'starting', detail: `${schema.name}:${format}` });

  try {
    if (format === 'xlsx') {
      const legacyCtx = buildLegacyCtxFromProtocol(ctx, canUseTool);
      const result = await executeExcelEdit(
        { file_path: filePath, operations: operations as ExcelEditParams['operations'], dry_run: dryRun },
        legacyCtx,
      );
      ctx.logger.debug('DocEdit xlsx done', { ok: result.success });
      onProgress?.({ stage: 'completing', percent: 100 });
      if (result.success) {
        return {
          ok: true,
          output: result.output ?? 'OK',
          meta: result.metadata,
        };
      }
      return {
        ok: false,
        error: result.error ?? 'excel edit failed',
        meta: result.metadata,
      };
    }

    if (format === 'docx') {
      const result = await executeDocxEdit({
        file_path: filePath,
        operations: operations as DocxEditParams['operations'],
        dry_run: dryRun,
      });
      ctx.logger.debug('DocEdit docx done', { ok: result.success });
      onProgress?.({ stage: 'completing', percent: 100 });
      if (result.success) {
        return {
          ok: true,
          output: result.output ?? 'OK',
          meta: result.metadata,
        };
      }
      return {
        ok: false,
        error: result.error ?? 'docx edit failed',
        meta: result.metadata,
      };
    }

    // pptx — dispatch via resolver to ppt_edit, one op per call
    const resolver = ctx.resolver as ToolResolver | undefined;
    if (!resolver || !resolver.has('ppt_edit')) {
      return {
        ok: false,
        error: 'PPT editing requires the ppt_edit tool. Use ppt_edit directly for .pptx files.',
        code: 'NOT_INITIALIZED',
      };
    }
    const legacyCtx = buildLegacyCtxFromProtocol(ctx, canUseTool);
    const results: string[] = [];
    for (const op of operations) {
      if (ctx.abortSignal.aborted) {
        return { ok: false, error: 'aborted', code: 'ABORTED', meta: { completedOps: results } };
      }
      const pptOp = op as Record<string, unknown>;
      const result = await resolver.execute(
        'ppt_edit',
        { file_path: filePath, ...pptOp },
        legacyCtx,
      );
      if (!result.success) {
        return {
          ok: false,
          error: `PPT edit failed at operation ${results.length + 1}: ${result.error}`,
          meta: { completedOps: results },
        };
      }
      results.push(result.output || 'OK');
    }
    ctx.logger.debug('DocEdit pptx done', { count: operations.length });
    onProgress?.({ stage: 'completing', percent: 100 });
    return {
      ok: true,
      output: `PPT edited (${operations.length} operations):\n${results.map((r, i) => `  ${i + 1}. ${r}`).join('\n')}`,
      meta: { outputPath: filePath, operationCount: operations.length },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.error('DocEdit failed', { error: message });
    return { ok: false, error: `DocEdit failed: ${message}`, code: 'FS_ERROR' };
  }
}

class DocEditHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeDocEdit(args, ctx, canUseTool, onProgress);
  }
}

export const docEditModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new DocEditHandler();
  },
};
