// ============================================================================
// Read (P0-6.3 Batch 1 — file-core: native ToolModule rewrite)
//
// 旧版: src/main/tools/file/read.ts (legacy Tool + wrapLegacyTool)
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - inline canUseTool 闸门 + onProgress 事件
// - 走 ctx.logger（不 import services/infra/logger）
// - 行为保真：
//   * offset/limit 按行分页（1-indexed，默认 offset=1, limit=2000）
//   * file_path 内嵌参数兼容（"file offset=N limit=N" / "file lines 7-9" 等）
//   * 每行 6 位对齐行号（cat -n 风格），超长行截断到 2000 字符
//   * endLine < 总行数时追加 "... (N more lines)" 尾标
//   * 二进制格式（xlsx/xls/docx/pdf/pptx）重定向到专用工具
//   * fileReadTracker.recordRead 记录（mtime + size，供 Edit 做外改检测）
//   * dataFingerprintStore.recordFact 提取文件指纹
//   * ENOENT 明确错误码
// ============================================================================

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { fileReadTracker } from '../../fileReadTracker';
import { extractFileFacts, dataFingerprintStore } from '../../dataFingerprint';
import { readSchema as schema } from './read.schema';

const BINARY_REDIRECTS: Record<string, string> = {
  '.xlsx': 'read_xlsx',
  '.xls': 'read_xlsx',
  '.docx': 'read_docx',
  '.pdf': 'read_pdf',
  '.pptx': 'read_file 不支持此格式',
};

const DEFAULT_OFFSET = 1;
const DEFAULT_LIMIT = 2000;
const MAX_LINE_WIDTH = 2000;

/** 展开 ~ 开头的 home 路径（避免反向 import 生产 pathUtils） */
function expandTilde(filePath: string): string {
  if (!filePath) return filePath;
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

/** 把输入路径解析为绝对路径（相对路径相对于 workingDir） */
function resolveInputPath(inputPath: string, workingDir: string): string {
  const expanded = expandTilde(inputPath);
  if (path.isAbsolute(expanded)) return expanded;
  return path.join(workingDir, expanded);
}

interface ParsedInput {
  inputPath: string;
  offset: number;
  limit: number;
}

/**
 * 兼容 AI 把参数写到 file_path 里的几种格式：
 *  1. "file.txt offset=10 limit=20"（带等号）
 *  2. "file.txt offset 10 limit 20"（空格分隔）
 *  3. "file.txt lines 7-9" / "file.txt lines 7"（行范围）
 */
function parseEmbeddedParams(rawPath: string, rawOffset: number, rawLimit: number): ParsedInput {
  let inputPath = rawPath;
  let offset = rawOffset;
  let limit = rawLimit;

  if (inputPath.includes(' offset=') || inputPath.includes(' limit=')) {
    const parts = inputPath.split(' ');
    inputPath = parts[0];
    for (const part of parts.slice(1)) {
      const [key, value] = part.split('=');
      if (key === 'offset' && value && !isNaN(Number(value))) offset = Number(value);
      else if (key === 'limit' && value && !isNaN(Number(value))) limit = Number(value);
    }
  }

  const spaceMatch = inputPath.match(
    /^(.+?)\s+(offset|limit)\s+(\d+)(?:\s+(offset|limit)\s+(\d+))?$/i,
  );
  if (spaceMatch) {
    inputPath = spaceMatch[1].trim();
    const extracted: Record<string, number> = {};
    if (spaceMatch[2] && spaceMatch[3]) {
      extracted[spaceMatch[2].toLowerCase()] = parseInt(spaceMatch[3], 10);
    }
    if (spaceMatch[4] && spaceMatch[5]) {
      extracted[spaceMatch[4].toLowerCase()] = parseInt(spaceMatch[5], 10);
    }
    if (extracted.offset) offset = extracted.offset;
    if (extracted.limit) limit = extracted.limit;
  }

  const linesMatch = inputPath.match(/^(.+?)\s+lines?\s+(\d+)(?:-(\d+))?$/i);
  if (linesMatch) {
    inputPath = linesMatch[1].trim();
    const startLine = parseInt(linesMatch[2], 10);
    const endLine = linesMatch[3] ? parseInt(linesMatch[3], 10) : startLine;
    offset = startLine;
    limit = endLine - startLine + 1;
  }

  return { inputPath, offset, limit };
}

class ReadHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    const rawPath = args.file_path;
    if (typeof rawPath !== 'string' || !rawPath) {
      return { ok: false, error: 'file_path is required and must be a string', code: 'INVALID_ARGS' };
    }

    const parsed = parseEmbeddedParams(
      rawPath,
      (args.offset as number) || DEFAULT_OFFSET,
      (args.limit as number) || DEFAULT_LIMIT,
    );

    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) {
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    const filePath = resolveInputPath(parsed.inputPath, ctx.workingDir);

    onProgress?.({ stage: 'starting', detail: `read ${path.basename(filePath)}` });

    // 二进制/结构化格式拦截 — 防止读到乱码后幻觉
    const ext = path.extname(filePath).toLowerCase();
    if (BINARY_REDIRECTS[ext]) {
      const hint = BINARY_REDIRECTS[ext];
      return {
        ok: false,
        error: `Cannot read ${ext} file as text — binary content will be garbled. Use ${hint} tool instead.\nPath: ${filePath}`,
        code: 'INVALID_ARGS',
      };
    }

    try {
      const stats = await fs.stat(filePath);
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');

      // 记录到 fileReadTracker（供 Edit 做外改检测）
      const resolvedAbs = path.resolve(filePath);
      fileReadTracker.recordRead(resolvedAbs, stats.mtimeMs, stats.size);

      const startLine = Math.max(0, parsed.offset - 1);
      const endLine = Math.min(lines.length, startLine + parsed.limit);
      const selectedLines = lines.slice(startLine, endLine);

      const formatted = selectedLines
        .map((line, index) => {
          const lineNum = startLine + index + 1;
          const paddedNum = String(lineNum).padStart(6, ' ');
          const truncated = line.length > MAX_LINE_WIDTH
            ? line.substring(0, MAX_LINE_WIDTH) + '...'
            : line;
          return `${paddedNum}\t${truncated}`;
        })
        .join('\n');

      let result = formatted;
      if (endLine < lines.length) {
        result += `\n\n... (${lines.length - endLine} more lines)`;
      }

      // 源数据锚定：CSV/JSON 提取 schema 指纹
      const fileFact = extractFileFacts(filePath, result);
      if (fileFact) {
        dataFingerprintStore.recordFact(fileFact);
      }

      onProgress?.({ stage: 'completing', percent: 100 });
      ctx.logger.debug('Read done', {
        filePath,
        lines: selectedLines.length,
        totalLines: lines.length,
      });
      return { ok: true, output: result };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        return { ok: false, error: `File not found: ${filePath}`, code: 'ENOENT' };
      }
      return {
        ok: false,
        error: e.message ?? 'Failed to read file',
        code: 'FS_ERROR',
      };
    }
  }
}

export const readModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ReadHandler();
  },
};
