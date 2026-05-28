// ============================================================================
// DocEdit (P1 Wave 2 — document: native ToolModule rewrite)
//
// 统一文档编辑入口：.xlsx/.pptx/.docx 按后缀自动分派
// - xlsx → executeExcelEdit (cross-cat 函数式 helper, excel category 待迁移)
// - docx → executeDocxEdit (本目录 docxEditCore.ts，已 native 化)
// - pptx → 通过 ctx.resolver 派发到 ppt_edit (cross-cat dispatch)
//
// 已去除 wrapLegacyTool / buildLegacyCtxFromProtocol，五链 + 错误码规范化:
// INVALID_ARGS / PERMISSION_DENIED / ABORTED / NOT_INITIALIZED / FS_ERROR
// ============================================================================

import * as path from 'path';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  CanUseToolResult,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import type { ToolResolver } from '../../dispatch/toolResolver';
import type {
  ToolContext as LegacyToolContext,
  PermissionRequestData,
} from '../../types';
import { executeExcelEdit, type ExcelEditParams } from '../../excel/excelEdit';
import { executeDocxEdit, type DocxEditParams } from './docxEditCore';
import { docEditSchema as schema } from './docEdit.schema';
import { createFileArtifact } from '../../artifacts/artifactMeta';

type DocFormat = 'xlsx' | 'pptx' | 'docx';

const FORMAT_MAP: Record<string, DocFormat> = {
  '.xlsx': 'xlsx',
  '.xls': 'xlsx',
  '.pptx': 'pptx',
  '.docx': 'docx',
};

async function buildDocumentEditMeta(
  filePath: string,
  format: DocFormat,
  operationCount: number,
  dryRun: boolean | undefined,
  metadata: Record<string, unknown> | undefined,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.workingDir, filePath);
  const artifact = dryRun
    ? undefined
    : await createFileArtifact(resolvedPath, schema.name, ctx, {
      kind: format === 'xlsx' ? 'spreadsheet' : 'document',
      metadata: {
        action: 'edit',
        operation: 'doc_edit',
        format,
        path: resolvedPath,
        operationCount,
      },
    }).catch(() => undefined);

  return {
    ...(metadata ?? {}),
    action: 'edit',
    operation: 'doc_edit',
    format,
    path: resolvedPath,
    outputPath: resolvedPath,
    operationCount,
    dryRun: Boolean(dryRun),
    changedFiles: dryRun ? [] : [resolvedPath],
    ...(artifact ? { artifact } : {}),
  };
}

// ---------------------------------------------------------------------------
// Local legacy ctx adapter — 仅用于 cross-cat dispatch（excelEdit / ppt_edit），
// 避免依赖 _helpers/legacyAdapter.ts。
// ---------------------------------------------------------------------------

async function forwardPermission(
  request: PermissionRequestData,
  canUseTool: CanUseToolFn,
): Promise<boolean> {
  const reason = request.type === 'dangerous_command' && request.reason
    ? `dangerous:${request.reason}`
    : request.reason;

  const result: CanUseToolResult = await canUseTool(
    request.tool,
    request.details ?? {},
    reason,
    request,
  );
  return result.allow;
}

function buildDispatchLegacyCtx(
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
): LegacyToolContext {
  const wrapEmit = (event: string, data: unknown) => {
    ctx.emit({ type: event, data } as never);
  };

  return {
    workingDirectory: ctx.workingDir,
    requestPermission: (request) => forwardPermission(request, canUseTool),
    abortSignal: ctx.abortSignal,
    sessionId: ctx.sessionId,
    emit: wrapEmit,
    emitEvent: wrapEmit,
    modelConfig: ctx.modelConfig,
    hookManager: ctx.hookManager as LegacyToolContext['hookManager'],
    planningService: ctx.planningService,
    modelCallback: ctx.modelCallback,
    currentToolCallId: ctx.currentToolCallId,
    agentId: ctx.subagent?.agentId,
    agentName: ctx.subagent?.agentName,
    agentRole: ctx.subagent?.agentRole,
    messages: ctx.subagent?.messages as LegacyToolContext['messages'],
    modifiedFiles: ctx.subagent?.modifiedFiles as LegacyToolContext['modifiedFiles'],
    todos: ctx.subagent?.todos as LegacyToolContext['todos'],
    currentAttachments: ctx.subagent?.attachments as LegacyToolContext['currentAttachments'],
    resolver: ctx.resolver,
    toolScope: ctx.toolScope,
    executionIntent: ctx.executionIntent,
  } as LegacyToolContext;
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

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
      // executeExcelEdit 的第二个参数 `_context` 内部未使用（excelEdit.ts:256），
      // 但签名仍要求 LegacyToolContext。传 minimal ctx 即可。
      const legacyCtx = buildDispatchLegacyCtx(ctx, canUseTool);
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
          meta: await buildDocumentEditMeta(filePath, format, operations.length, dryRun, result.metadata, ctx),
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
          meta: await buildDocumentEditMeta(filePath, format, operations.length, dryRun, result.metadata, ctx),
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
    if (!resolver?.has('ppt_edit')) {
      return {
        ok: false,
        error: 'PPT editing requires the ppt_edit tool. Use ppt_edit directly for .pptx files.',
        code: 'NOT_INITIALIZED',
      };
    }
    const legacyCtx = buildDispatchLegacyCtx(ctx, canUseTool);
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
      meta: await buildDocumentEditMeta(filePath, format, operations.length, dryRun, { completedOps: results }, ctx),
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

// 暴露给反向 shim / 测试
export { executeDocEdit };
