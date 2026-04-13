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
  ToolSchema,
} from '../../../protocol/tools';
import { executeReadPdf } from './readPdf';
import { executeReadDocx } from './readDocx';
import { executeReadXlsx } from './readXlsx';

type DocHandler = 'pdf' | 'docx' | 'xlsx';

const EXTENSION_MAP: Record<string, DocHandler> = {
  '.pdf': 'pdf',
  '.doc': 'docx',
  '.docx': 'docx',
  '.xls': 'xlsx',
  '.xlsx': 'xlsx',
};

const schema: ToolSchema = {
  name: 'ReadDocument',
  description: `Read document files (PDF, Word, Excel) with automatic format detection from file extension.

Supported formats:
- .pdf: Uses vision model (Gemini 2.0) for AI-powered PDF analysis
- .docx / .doc: Reads Word documents with text/markdown/html output
- .xlsx / .xls: Reads Excel spreadsheets with table/json/csv output and data quality analysis

The format is auto-detected from the file extension. No action parameter needed.

Parameters:
- file_path (required): Path to the document file
- prompt (optional, PDF only): Specific question or instruction for analyzing the PDF
- format (optional): Output format - for Word: text|markdown|html (default: text); for Excel: table|json|csv (default: table)
- sheet (optional, Excel only): Worksheet name or index (default: first sheet)
- max_rows (optional, Excel only): Maximum rows to read (default: 1000)

Examples:
- Read PDF: { "file_path": "/path/to/report.pdf" }
- Read PDF with prompt: { "file_path": "/path/to/paper.pdf", "prompt": "Summarize the key findings" }
- Read Word: { "file_path": "/path/to/doc.docx", "format": "markdown" }
- Read Excel: { "file_path": "/path/to/data.xlsx", "format": "json", "sheet": "Sheet2" }`,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Path to the document file (.pdf, .docx, .doc, .xlsx, .xls)',
      },
      prompt: {
        type: 'string',
        description: '[PDF] Specific question or instruction for analyzing the PDF',
      },
      format: {
        type: 'string',
        description:
          '[Word] text|markdown|html (default: text); [Excel] table|json|csv (default: table)',
      },
      sheet: {
        type: 'string',
        description: '[Excel] Worksheet name or index (default: first sheet)',
      },
      max_rows: {
        type: 'number',
        description: '[Excel] Maximum rows to read (default: 1000)',
      },
    },
    required: ['file_path'],
  },
  category: 'network',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
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
