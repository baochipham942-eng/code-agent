// ============================================================================
// Read File Tool - Read file contents
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import type { Tool, ToolContext, ToolExecutionResult } from '../ToolRegistry';

export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read the contents of a file from the filesystem',
  generations: ['gen1', 'gen2', 'gen3', 'gen4'],
  requiresPermission: true,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to read',
      },
      offset: {
        type: 'number',
        description: 'Line number to start reading from (1-indexed)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of lines to read',
      },
    },
    required: ['file_path'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    let filePath = params.file_path as string;
    const offset = (params.offset as number) || 1;
    const limit = (params.limit as number) || 2000;

    // Resolve relative paths
    if (!path.isAbsolute(filePath)) {
      filePath = path.join(context.workingDirectory, filePath);
    }

    try {
      // Check if file exists
      await fs.access(filePath);

      // Read file
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');

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
