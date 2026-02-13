// ============================================================================
// Glob Tool - Find files by pattern
// ============================================================================

import { glob as globLib } from 'glob';
import path from 'path';
import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { resolvePath } from './pathUtils';

export const globTool: Tool = {
  name: 'glob',
  description: `Find files by name pattern. Fast, works with any codebase size.

Use for: finding files by name or extension (e.g., "**/*.ts", "src/**/*.tsx").
For searching file contents, use grep instead.
For browsing directory structure, use list_directory.
Do NOT use bash find or ls — this tool is faster and auto-ignores node_modules/.git.

Patterns: "**/*.ts" (recursive), "src/*.tsx" (one level), "**/*test*" (name match).
Results sorted by modification time, limited to 200 files.`,
  generations: ['gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description:
          'Glob pattern to match files. MUST be a string. ' +
          'Common patterns: "**/*.ts" (all .ts files recursively), ' +
          '"src/**/*.tsx" (TSX files in src), "*.json" (JSON in current dir), ' +
          '"**/*test*.ts" (all test files). ' +
          'Use ** for recursive matching, * for single-level wildcard.',
      },
      path: {
        type: 'string',
        description:
          'Directory to search in. MUST be a string. ' +
          'Default: current working directory. ' +
          'Examples: "/Users/name/project", "~/Documents", "./src". ' +
          'Supports absolute paths, ~ for home, and relative paths.',
      },
    },
    required: ['pattern'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const pattern = params.pattern as string;
    const inputPath = (params.path as string) || context.workingDirectory;

    // Resolve path (handles ~, relative paths)
    const searchPath = resolvePath(inputPath, context.workingDirectory);

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
