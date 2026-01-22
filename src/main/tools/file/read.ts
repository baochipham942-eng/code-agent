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

const logger = createLogger('ReadFile');

export const readFileTool: Tool = {
  name: 'read_file',
  description: `Read the contents of a file from the local filesystem.

Usage:
- The file_path must be an absolute path, not a relative path
- By default, reads up to 2000 lines starting from line 1
- Use offset and limit for large files (e.g., offset: 100, limit: 50 reads lines 100-149)
- Lines longer than 2000 characters will be truncated
- Results are returned with line numbers (1-indexed) for easy reference

Best practices:
- ALWAYS read a file before editing it with edit_file
- If a file is too large, use offset/limit to read specific sections
- For searching within files, prefer grep tool over read_file
- Multiple files can be read in parallel with separate tool calls

Returns: File content with line numbers in format "  lineNum\\tcontent"`,
  generations: ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
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

    // 兼容处理：AI 可能把参数写到 file_path 里（如 "file.txt offset=10 limit=20"）
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

    // Resolve path (handles ~, relative paths)
    const filePath = resolvePath(inputPath, context.workingDirectory);

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

      return {
        success: true,
        output: result,
      };
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return {
          success: false,
          error: `File not found: ${filePath}`,
        };
      }
      return {
        success: false,
        error: error.message || 'Failed to read file',
      };
    }
  },
};
