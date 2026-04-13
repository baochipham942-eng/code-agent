// ============================================================================
// read_docx (P0-6.3 Batch 8 — network: native ToolModule rewrite)
//
// 读取 Word 文档（.docx）内容。支持 text / markdown / html 三种输出格式。
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import mammoth from 'mammoth';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
  ToolSchema,
} from '../../../protocol/tools';

type DocxFormat = 'text' | 'markdown' | 'html';

const schema: ToolSchema = {
  name: 'read_docx',
  description: `读取 Word 文档（.docx）的内容。

支持输出格式：
- text: 纯文本（默认）
- markdown: Markdown 格式（保留标题、列表等）
- html: HTML 格式

**使用示例：**
\`\`\`
read_docx { "file_path": "report.docx" }
read_docx { "file_path": "report.docx", "format": "markdown" }
\`\`\``,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Word 文档路径',
      },
      format: {
        type: 'string',
        enum: ['text', 'markdown', 'html'],
        description: '输出格式（默认: text）',
        default: 'text',
      },
    },
    required: ['file_path'],
  },
  category: 'network',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};

export async function executeReadDocx(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const filePath = args.file_path;
  const format = (args.format as DocxFormat | undefined) ?? 'text';

  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { ok: false, error: 'file_path is required and must be a string', code: 'INVALID_ARGS' };
  }
  if (!['text', 'markdown', 'html'].includes(format)) {
    return { ok: false, error: `format must be text|markdown|html, got: ${format}`, code: 'INVALID_ARGS' };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: `read_docx:${format}` });

  const absPath = path.isAbsolute(filePath) ? filePath : path.join(ctx.workingDir, filePath);

  if (!fs.existsSync(absPath)) {
    return { ok: false, error: `文件不存在: ${absPath}`, code: 'ENOENT' };
  }

  const ext = path.extname(absPath).toLowerCase();
  if (ext !== '.docx') {
    return { ok: false, error: `不支持的文件格式: ${ext}，仅支持 .docx`, code: 'INVALID_ARGS' };
  }

  try {
    onProgress?.({ stage: 'running', detail: `📄 正在读取: ${path.basename(absPath)}` });

    const buffer = fs.readFileSync(absPath);
    let result: string;
    let messages: string[] = [];

    if (format === 'html') {
      const extracted = await mammoth.convertToHtml({ buffer });
      result = extracted.value;
      messages = extracted.messages.map((m: { message: string }) => m.message);
    } else if (format === 'markdown') {
      // mammoth 不直接支持 markdown，使用 html 后转换
      const extracted = await mammoth.convertToHtml({ buffer });
      result = extracted.value
        .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n')
        .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n')
        .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n')
        .replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n')
        .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
        .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
        .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
        .replace(/<[^>]+>/g, '')
        .trim();
      messages = extracted.messages.map((m: { message: string }) => m.message);
    } else {
      const extracted = await mammoth.extractRawText({ buffer });
      result = extracted.value;
      messages = extracted.messages.map((m: { message: string }) => m.message);
    }

    const charCount = result.length;
    const wordCount = result.split(/\s+/).filter(w => w).length;
    const lineCount = result.split('\n').length;

    ctx.logger.info('DOCX read', { path: absPath, format, charCount });

    let output = `📄 Word 文档内容 (${path.basename(absPath)})\n`;
    output += `格式: ${format} | 字符: ${charCount} | 词数: ${wordCount} | 行数: ${lineCount}\n`;
    output += `${'─'.repeat(50)}\n\n`;
    output += result;

    if (messages.length > 0) {
      output += `\n\n⚠️ 警告信息:\n${messages.join('\n')}`;
    }

    onProgress?.({ stage: 'completing', percent: 100 });

    return {
      ok: true,
      output,
      meta: {
        filePath: absPath,
        format,
        charCount,
        wordCount,
        lineCount,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.error('DOCX read failed', { error: message });
    return { ok: false, error: `Word 文档读取失败: ${message}`, code: 'FS_ERROR' };
  }
}

class ReadDocxHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeReadDocx(args, ctx, canUseTool, onProgress);
  }
}

export const readDocxModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ReadDocxHandler();
  },
};
