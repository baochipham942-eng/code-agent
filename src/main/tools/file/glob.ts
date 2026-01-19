// ============================================================================
// Glob Tool - Find files by pattern
// ============================================================================

import { glob as globLib } from 'glob';
import path from 'path';
import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';

export const globTool: Tool = {
  name: 'glob',
  description: `Fast file pattern matching tool that works with any codebase size.

Usage:
- Supports glob patterns like "**/*.ts", "src/**/*.tsx", "*.json"
- Returns matching file paths sorted by modification time
- Results limited to 200 files (additional files are indicated in output)

Common patterns:
- "**/*.ts" - All TypeScript files recursively
- "src/**/*.tsx" - All TSX files in src directory
- "*.config.js" - Config files in current directory
- "**/*test*.ts" - All test files

Auto-ignored directories:
- node_modules, .git, dist, build, .next, coverage

Best practices:
- Use this tool instead of bash find or ls commands
- When searching for a specific file, use a specific pattern
- For content search (finding text inside files), use grep instead
- Multiple glob patterns can be searched in parallel with separate tool calls

When NOT to use:
- For searching file CONTENTS - use grep instead
- For reading a file you already know the path to - use read_file instead`,
  generations: ['gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
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
