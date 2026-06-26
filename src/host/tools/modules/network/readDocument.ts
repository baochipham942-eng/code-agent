// ============================================================================
// ReadDocument (P0-6.3 Batch 8 — network: native ToolModule rewrite)
//
// 统一文档读取入口：按文件扩展名自动分派到 read_pdf / read_docx / read_xlsx 的
// sibling native 实现（同目录 executeFn 直调，不走 resolver）。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { executeReadPdf } from './readPdf';
import { executeReadDocx } from './readDocx';
import { executeReadXlsx } from './readXlsx';
import { readDocumentSchema as schema } from './readDocument.schema';

type DocHandler = 'pdf' | 'docx' | 'xlsx';

const EXTENSION_MAP: Record<string, DocHandler> = {
  '.pdf': 'pdf',
  '.doc': 'docx',
  '.docx': 'docx',
  '.xls': 'xlsx',
  '.xlsx': 'xlsx',
};

async function executeReadDocument(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const filePath = args.file_path;

  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { ok: false, error: 'file_path is required and must be a string', code: 'INVALID_ARGS' };
  }

  const dotIndex = filePath.lastIndexOf('.');
  if (dotIndex === -1) {
    return {
      ok: false,
      error: `Cannot detect file format: no extension found in "${filePath}". Supported: .pdf, .docx, .doc, .xlsx, .xls`,
      code: 'INVALID_ARGS',
    };
  }

  const ext = filePath.substring(dotIndex).toLowerCase();
  const handler = EXTENSION_MAP[ext];
  if (!handler) {
    return {
      ok: false,
      error: `Unsupported file format: ${ext}. Supported extensions: ${Object.keys(EXTENSION_MAP).join(', ')}`,
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

  onProgress?.({ stage: 'starting', detail: `ReadDocument:${handler}` });

  // 分派给对应的 native executeFn（sibling 文件直调，不走 resolver）
  // 注意：被调的 executeFn 内部会再次 canUseTool — 这里传的是同一个 canUseTool，
  // 幂等闸门，符合 PR 模板的"每个 native tool 自己做权限检查"约定。
  if (handler === 'pdf') {
    return executeReadPdf(args, ctx, canUseTool, onProgress);
  }
  if (handler === 'docx') {
    return executeReadDocx(args, ctx, canUseTool, onProgress);
  }
  if (handler === 'xlsx') {
    return executeReadXlsx(args, ctx, canUseTool, onProgress);
  }

  return {
    ok: false,
    error: `Internal error: unhandled handler type "${handler}"`,
    code: 'INVALID_ARGS',
  };
}

class ReadDocumentHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeReadDocument(args, ctx, canUseTool, onProgress);
  }
}

export const readDocumentModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ReadDocumentHandler();
  },
};
