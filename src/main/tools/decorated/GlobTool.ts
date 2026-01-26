// ============================================================================
// GlobTool - Find files by pattern (Decorator Version)
// ============================================================================
//
// 这是使用装饰器重构的 glob 工具示例。
// 相比原版（约 107 行），装饰器版本更简洁且类型安全。
//

import { glob as globLib } from 'glob';
import { Tool, Param, Description, type ITool } from '../decorators';
import type { ToolContext, ToolExecutionResult } from '../toolRegistry';
import { resolvePath } from '../file/pathUtils';

// ----------------------------------------------------------------------------
// Tool Definition using Decorators
// ----------------------------------------------------------------------------

@Tool('glob', {
  generations: 'gen2+',  // gen2 及以上所有代际
  permission: 'none',    // 不需要权限确认
})
@Description(`Fast file pattern matching tool that works with any codebase size.

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
- For reading a file you already know the path to - use read_file instead`)
@Param('pattern', {
  type: 'string',
  required: true,
  description: 'The glob pattern to match (e.g., "**/*.ts")',
})
@Param('path', {
  type: 'string',
  required: false,
  description: 'Directory to search in (default: working directory)',
})
export class GlobTool implements ITool {
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
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to search files';
      return {
        success: false,
        error: message,
      };
    }
  }
}
