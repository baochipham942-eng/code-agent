// ============================================================================
// Read File Tool - Read file contents
// ============================================================================
// Enhanced to track file reads for edit_file safety checks
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { resolvePath } from './pathUtils';
import { createLogger } from '../../services/infra/logger';
import { fileReadTracker } from '../fileReadTracker';
import { extractFileFacts, dataFingerprintStore } from '../dataFingerprint';

const logger = createLogger('ReadFile');

export const readFileTool: Tool = {
  name: 'Read',
  description: `Reads a file from the local filesystem. Use this instead of Bash cat/head/tail. Supports offset and limit for large files. Can read images, PDFs (use pages param for large PDFs), and Jupyter notebooks. Cannot read directories — use Bash ls for that.`,
  requiresPermission: true,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description:
          'Absolute path to the file. MUST be a string, not an object. ' +
          'Examples: "/Users/name/project/src/index.ts", "/home/user/config.json". ' +
          'Supports ~ for home directory: "~/Documents/file.txt". ' +
          'Do NOT include parameters like offset or limit in this string.',
      },
      offset: {
        type: 'number',
        description:
          'Line number to start reading from. Integer, 1-indexed (first line is 1, not 0). ' +
          'Default: 1. Example: offset=100 starts reading from line 100. ' +
          'If offset exceeds total lines, returns empty content.',
      },
      limit: {
        type: 'number',
        description:
          'Maximum number of lines to read. Integer, must be positive. ' +
          'Default: 2000. Example: limit=50 reads up to 50 lines. ' +
          'Combined with offset: offset=100, limit=50 reads lines 100-149.',
      },
    },
    required: ['file_path'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    let inputPath = params.file_path as string;
    let offset = (params.offset as number) || 1;
    let limit = (params.limit as number) || 2000;

    // 兼容处理：AI 可能把参数写到 file_path 里
    // 格式1: "file.txt offset=10 limit=20" (带等号)
    if (inputPath.includes(' offset=') || inputPath.includes(' limit=')) {
      const parts = inputPath.split(' ');
      inputPath = parts[0]; // 第一部分是实际路径

      for (const part of parts.slice(1)) {
        const [key, value] = part.split('=');
        if (key === 'offset' && value && !isNaN(Number(value))) {
          offset = Number(value);
        } else if (key === 'limit' && value && !isNaN(Number(value))) {
          limit = Number(value);
        }
      }
    }

    // 格式2: "file.txt offset 10 limit 20" (空格分隔，无等号)
    const spaceParamMatch = inputPath.match(
      /^(.+?)\s+(offset|limit)\s+(\d+)(?:\s+(offset|limit)\s+(\d+))?$/i
    );
    if (spaceParamMatch) {
      inputPath = spaceParamMatch[1].trim();
      const extractedParams: Record<string, number> = {};
      if (spaceParamMatch[2] && spaceParamMatch[3]) {
        extractedParams[spaceParamMatch[2].toLowerCase()] = parseInt(spaceParamMatch[3], 10);
      }
      if (spaceParamMatch[4] && spaceParamMatch[5]) {
        extractedParams[spaceParamMatch[4].toLowerCase()] = parseInt(spaceParamMatch[5], 10);
      }
      if (extractedParams.offset) offset = extractedParams.offset;
      if (extractedParams.limit) limit = extractedParams.limit;
    }

    // 格式3: "file.txt lines 7-9" 或 "file.txt lines 7" (行范围)
    const linesMatch = inputPath.match(/^(.+?)\s+lines?\s+(\d+)(?:-(\d+))?$/i);
    if (linesMatch) {
      inputPath = linesMatch[1].trim();
      const startLine = parseInt(linesMatch[2], 10);
      const endLine = linesMatch[3] ? parseInt(linesMatch[3], 10) : startLine;
      offset = startLine;
      limit = endLine - startLine + 1;
    }

    // Resolve path (handles ~, relative paths)
    const filePath = resolvePath(inputPath, context.workingDirectory);

    // 拦截二进制/结构化格式：强制引导到正确工具，防止读到乱码后幻觉
    const ext = path.extname(filePath).toLowerCase();
    const BINARY_REDIRECTS: Record<string, string> = {
      '.xlsx': 'read_xlsx', '.xls': 'read_xlsx',
      '.docx': 'read_docx',
      '.pdf': 'read_pdf',
      '.pptx': 'read_file 不支持此格式',
    };
    if (BINARY_REDIRECTS[ext]) {
      const hint = BINARY_REDIRECTS[ext];
      return {
        success: false,
        error: `Cannot read ${ext} file as text — binary content will be garbled. Use ${hint} tool instead.\nPath: ${filePath}`,
      };
    }

    try {
      // Get file stats for tracking
      const stats = await fs.stat(filePath);

      // Read file
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');

      // Record the read in the tracker (for edit_file safety checks)
      const resolvedPath = path.resolve(filePath);
      fileReadTracker.recordRead(resolvedPath, stats.mtimeMs, stats.size);

      // Apply offset and limit
      const startLine = Math.max(0, offset - 1);
      const endLine = Math.min(lines.length, startLine + limit);
      const selectedLines = lines.slice(startLine, endLine);

      // Format output with line numbers
      const output = selectedLines
        .map((line, index) => {
          const lineNum = startLine + index + 1;
          const paddedNum = String(lineNum).padStart(6, ' ');
          // Truncate long lines
          const truncatedLine =
            line.length > 2000 ? line.substring(0, 2000) + '...' : line;
          return `${paddedNum}\t${truncatedLine}`;
        })
        .join('\n');

      // Add info about total lines if truncated
      let result = output;
      if (endLine < lines.length) {
        result += `\n\n... (${lines.length - endLine} more lines)`;
      }

      // 源数据锚定：CSV/JSON 文件提取 schema 指纹
      const fileFact = extractFileFacts(filePath, result);
      if (fileFact) {
        dataFingerprintStore.recordFact(fileFact);
      }

      return {
        success: true,
        output: result,
      };
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      if ((error as Record<string, unknown>).code === 'ENOENT') {
        return {
          success: false,
          error: `File not found: ${filePath}`,
        };
      }
      return {
        success: false,
        error: errMsg || 'Failed to read file',
      };
    }
  },
};
