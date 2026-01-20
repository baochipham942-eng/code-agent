// ============================================================================
// Read File Tool (Decorator Version) - Read file contents
// ============================================================================

import fs from 'fs/promises';
import { Tool, Param, Description, type ITool, buildToolFromClass } from '../decorators';
import type { ToolContext, ToolExecutionResult } from '../toolRegistry';
import { resolvePath } from './pathUtils';

@Description(`Read the contents of a file from the local filesystem.

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

Returns: File content with line numbers in format "  lineNum\\tcontent"`)
@Tool('read_file', { generations: 'gen1+', permission: 'read' })
@Param('file_path', { type: 'string', required: true, description: 'The absolute path to the file to read' })
@Param('offset', { type: 'number', required: false, description: 'Line number to start reading from (1-indexed)' })
@Param('limit', { type: 'number', required: false, description: 'Maximum number of lines to read' })
class ReadFileToolDecorated implements ITool {
  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const inputPath = params.file_path as string;
    const offset = (params.offset as number) || 1;
    const limit = (params.limit as number) || 2000;

    // Resolve path (handles ~, relative paths)
    const filePath = resolvePath(inputPath, context.workingDirectory);

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
  }
}

// 导出构建后的工具
export const readFileToolDecorated = buildToolFromClass(ReadFileToolDecorated);
