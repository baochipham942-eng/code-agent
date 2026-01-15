// ============================================================================
// Glob Tool - Find files by pattern
// ============================================================================

import { glob as globLib } from 'glob';
import path from 'path';
import type { Tool, ToolContext, ToolExecutionResult } from '../ToolRegistry';

export const globTool: Tool = {
  name: 'glob',
  description: 'Find files matching a glob pattern',
  generations: ['gen2', 'gen3', 'gen4'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The glob pattern to match (e.g., "**/*.ts")',
      },
      path: {
        type: 'string',
        description: 'Directory to search in (default: working directory)',
      },
    },
    required: ['pattern'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const pattern = params.pattern as string;
    let searchPath = (params.path as string) || context.workingDirectory;

    // Resolve relative paths
    if (!path.isAbsolute(searchPath)) {
      searchPath = path.join(context.workingDirectory, searchPath);
    }

    try {
      const matches = await globLib(pattern, {
        cwd: searchPath,
        nodir: true,
        ignore: [
          '**/node_modules/**',
          '**/.git/**',
          '**/dist/**',
          '**/build/**',
          '**/.next/**',
          '**/coverage/**',
        ],
      });

      if (matches.length === 0) {
        return {
          success: true,
          output: 'No files matched the pattern',
        };
      }

      // Sort by modification time (if we can get it)
      const sortedMatches = matches.slice(0, 200); // Limit to 200 files

      const output = sortedMatches.join('\n');
      let result = output;

      if (matches.length > 200) {
        result += `\n\n... (${matches.length - 200} more files)`;
      }

      return {
        success: true,
        output: result,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to search files',
      };
    }
  },
};
