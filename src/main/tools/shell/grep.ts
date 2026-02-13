// ============================================================================
// Grep Tool - Search file contents
// ============================================================================
// Enhanced with context lines (-A/-B/-C) and file type filtering (--type)
// ============================================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { GREP, BASH } from '../../../shared/constants';

/**
 * File type to extension mapping for --type parameter
 * Matches ripgrep's type definitions
 */
const FILE_TYPE_MAP: Record<string, string[]> = {
  js: ['*.js', '*.mjs', '*.cjs'],
  ts: ['*.ts', '*.mts', '*.cts'],
  jsx: ['*.jsx'],
  tsx: ['*.tsx'],
  py: ['*.py', '*.pyi'],
  rust: ['*.rs'],
  go: ['*.go'],
  java: ['*.java'],
  c: ['*.c', '*.h'],
  cpp: ['*.cpp', '*.cc', '*.cxx', '*.hpp', '*.hh', '*.hxx', '*.h'],
  css: ['*.css', '*.scss', '*.sass', '*.less'],
  html: ['*.html', '*.htm'],
  json: ['*.json'],
  yaml: ['*.yaml', '*.yml'],
  md: ['*.md', '*.markdown'],
  xml: ['*.xml'],
  sql: ['*.sql'],
  sh: ['*.sh', '*.bash', '*.zsh'],
  ruby: ['*.rb'],
  php: ['*.php'],
  swift: ['*.swift'],
  kotlin: ['*.kt', '*.kts'],
};

const execAsync = promisify(exec);

export const grepTool: Tool = {
  name: 'grep',
  description: `Search file contents using regex patterns. Built on ripgrep for speed.

Use for: finding function definitions, imports, string occurrences, TODO comments.
For finding files by name/path, use glob instead.
Do NOT use bash with grep/rg — this tool is faster and provides structured output.

Key parameters:
- pattern: regex (e.g., "function\\s+\\w+", "TODO|FIXME")
- path: file or directory (default: working directory)
- type: filter by file type — more efficient than include (e.g., type="ts" instead of include="*.ts")
- include: glob pattern filter (e.g., "*.{js,jsx}")
- context (-C), before_context (-B), after_context (-A): show surrounding lines

Output: file:line_number:matching_line, limited to 200 matches.
Auto-ignores: node_modules, .git, dist, build.

Tips:
- Escape regex special chars: . * + ? [ ] ( ) { } | \\ ^ $
- Multiple searches can run in parallel with separate tool calls`,
  generations: ['gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description:
          'Regex pattern to search for. MUST be a string. ' +
          'Examples: "function\\\\s+handleClick" (function definitions), ' +
          '"import.*from" (import statements), "TODO|FIXME" (comments). ' +
          'Escape special regex chars: . * + ? [ ] ( ) { } | \\\\ ^ $',
      },
      path: {
        type: 'string',
        description:
          'File or directory to search in. MUST be a string. ' +
          'Default: current working directory. ' +
          'Examples: "/Users/name/project/src", "./src/components", "~/project". ' +
          'Can be a specific file: "/path/to/file.ts".',
      },
      include: {
        type: 'string',
        description:
          'Glob pattern to filter which files to search. MUST be a string. ' +
          'Examples: "*.ts" (TypeScript only), "*.{js,jsx}" (JS and JSX), ' +
          '"*.test.ts" (test files only). Without this, searches all text files.',
      },
      case_insensitive: {
        type: 'boolean',
        description:
          'If true, performs case-insensitive matching. Default: false. ' +
          'Example: with case_insensitive=true, "error" matches "Error", "ERROR", "error".',
      },
      type: {
        type: 'string',
        description:
          'Filter by file type. More efficient than include glob. ' +
          'Supported types: js, ts, jsx, tsx, py, rust, go, java, c, cpp, css, html, json, yaml, md, xml, sql, sh, ruby, php, swift, kotlin. ' +
          'Example: type="ts" searches only TypeScript files.',
      },
      before_context: {
        type: 'number',
        description:
          'Number of lines to show BEFORE each match (like grep -B). ' +
          'Useful for seeing context leading up to a match. ' +
          'Example: before_context=3 shows 3 lines before each match.',
      },
      after_context: {
        type: 'number',
        description:
          'Number of lines to show AFTER each match (like grep -A). ' +
          'Useful for seeing what follows a match. ' +
          'Example: after_context=3 shows 3 lines after each match.',
      },
      context: {
        type: 'number',
        description:
          'Number of lines to show BEFORE and AFTER each match (like grep -C). ' +
          'Shorthand for setting both before_context and after_context. ' +
          'Example: context=2 shows 2 lines before and 2 lines after each match.',
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
    const fileType = params.type as string;
    const caseInsensitive = (params.case_insensitive as boolean) || false;
    const beforeContext = params.before_context as number | undefined;
    const afterContext = params.after_context as number | undefined;
    const contextLines = params.context as number | undefined;

    // Resolve relative paths
    if (!path.isAbsolute(searchPath)) {
      searchPath = path.join(context.workingDirectory, searchPath);
    }

    // Determine context settings (context overrides before/after if set)
    const ctxBefore = contextLines ?? beforeContext;
    const ctxAfter = contextLines ?? afterContext;

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

        // Add context flags
        if (ctxBefore !== undefined && ctxBefore > 0) {
          flags.push('-B', String(Math.min(ctxBefore, 10))); // Cap at 10 lines
        }
        if (ctxAfter !== undefined && ctxAfter > 0) {
          flags.push('-A', String(Math.min(ctxAfter, 10))); // Cap at 10 lines
        }

        // File type filtering (more efficient than glob)
        if (fileType && FILE_TYPE_MAP[fileType]) {
          for (const ext of FILE_TYPE_MAP[fileType]) {
            flags.push('-g', ext);
          }
        } else if (include) {
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

        // Add context flags
        if (ctxBefore !== undefined && ctxBefore > 0) {
          flags.push('-B', String(Math.min(ctxBefore, 10)));
        }
        if (ctxAfter !== undefined && ctxAfter > 0) {
          flags.push('-A', String(Math.min(ctxAfter, 10)));
        }

        // File type filtering (convert to --include patterns)
        if (fileType && FILE_TYPE_MAP[fileType]) {
          for (const ext of FILE_TYPE_MAP[fileType]) {
            flags.push('--include', ext);
          }
        } else if (include) {
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
