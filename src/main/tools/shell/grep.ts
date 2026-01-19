// ============================================================================
// Grep Tool - Search file contents
// ============================================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { GREP, BASH } from '../../../shared/constants';

const execAsync = promisify(exec);

export const grepTool: Tool = {
  name: 'grep',
  description: `Search for patterns in file contents using regex.

Built on ripgrep (with grep fallback) for fast content search.

Usage:
- pattern: Regex pattern to search for (e.g., "function\\s+\\w+", "TODO:")
- path: File or directory to search in (default: working directory)
- include: Glob pattern to filter files (e.g., "*.ts", "*.{js,jsx}")
- case_insensitive: Set to true for case-insensitive search

Output format:
- Returns file:line_number:matching_line
- Results limited to 200 matches
- Each line truncated at 500 characters

Auto-ignored directories:
- node_modules, .git, dist, build

Common patterns:
- "function\\s+handleClick" - Find function definitions
- "import.*from\\s+['\"]react['\"]" - Find React imports
- "TODO|FIXME|HACK" - Find code comments
- "class\\s+\\w+\\s+extends" - Find class definitions

Best practices:
- Use this tool instead of bash grep or rg commands
- For finding file paths (not content), use glob instead
- Escape special regex characters: . * + ? [ ] ( ) { } | \\ ^ $
- Multiple searches can be run in parallel with separate tool calls`,
  generations: ['gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The regex pattern to search for',
      },
      path: {
        type: 'string',
        description: 'File or directory to search in',
      },
      include: {
        type: 'string',
        description: 'Glob pattern to filter files (e.g., "*.ts")',
      },
      case_insensitive: {
        type: 'boolean',
        description: 'Case-insensitive search (default: false)',
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
    const include = params.include as string;
    const caseInsensitive = (params.case_insensitive as boolean) || false;

    // Resolve relative paths
    if (!path.isAbsolute(searchPath)) {
      searchPath = path.join(context.workingDirectory, searchPath);
    }

    try {
      // Build grep/rg command
      // Prefer ripgrep if available, fallback to grep
      let command: string;

      // Check if ripgrep is available
      try {
        await execAsync('which rg');
        // Use ripgrep
        const flags = [
          '-n', // Line numbers
          '--color=never',
          '-M', String(GREP.MAX_LINE_LENGTH), // Max line length
          '--max-count', String(GREP.MAX_MATCHES_PER_FILE), // Max matches per file
        ];

        if (caseInsensitive) {
          flags.push('-i');
        }

        if (include) {
          flags.push('-g', include);
        }

        // Common ignores
        flags.push(
          '--glob', '!node_modules',
          '--glob', '!.git',
          '--glob', '!dist',
          '--glob', '!build'
        );

        command = `rg ${flags.join(' ')} "${pattern.replace(/"/g, '\\"')}" "${searchPath}"`;
      } catch {
        // Fallback to grep
        const flags = [
          '-r', // Recursive
          '-n', // Line numbers
          '-E', // Extended regex
        ];

        if (caseInsensitive) {
          flags.push('-i');
        }

        if (include) {
          flags.push('--include', include);
        }

        // Exclude common directories
        flags.push(
          '--exclude-dir=node_modules',
          '--exclude-dir=.git',
          '--exclude-dir=dist',
          '--exclude-dir=build'
        );

        command = `grep ${flags.join(' ')} "${pattern.replace(/"/g, '\\"')}" "${searchPath}"`;
      }

      const { stdout } = await execAsync(command, {
        maxBuffer: BASH.MAX_BUFFER,
        timeout: GREP.DEFAULT_TIMEOUT,
      });

      // Limit output
      const lines = stdout.split('\n').filter(Boolean);
      let output = lines.slice(0, GREP.MAX_TOTAL_MATCHES).join('\n');

      if (lines.length > GREP.MAX_TOTAL_MATCHES) {
        output += `\n\n... (${lines.length - GREP.MAX_TOTAL_MATCHES} more matches)`;
      }

      return {
        success: true,
        output: output || 'No matches found',
      };
    } catch (error: any) {
      // grep returns exit code 1 when no matches found
      if (error.code === 1 && !error.stderr) {
        return {
          success: true,
          output: 'No matches found',
        };
      }
      return {
        success: false,
        error: error.message || 'Search failed',
      };
    }
  },
};
