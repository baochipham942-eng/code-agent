// ============================================================================
// Grep Tool - Search file contents
// ============================================================================
// Enhanced with context lines (-A/-B/-C), file type filtering (--type),
// EAGAIN retry, execFile (no shell injection), head_limit/offset pagination
// ============================================================================

import { execFile } from 'child_process';
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

const execFileAsync = promisify(execFile);

/**
 * Check if an error is an EAGAIN (resource temporarily unavailable) error.
 * This can happen on macOS / Linux when ripgrep's thread pool hits OS limits.
 */
function isEagainError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { stderr?: string; message?: string; code?: string };
  const text = (err.stderr || err.message || '').toLowerCase();
  return text.includes('resource temporarily unavailable')
    || text.includes('eagain')
    || err.code === 'EAGAIN';
}

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
- head_limit: limit output to first N match groups (default: 0 = unlimited)
- offset: skip first N match groups before applying head_limit (default: 0)

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
      head_limit: {
        type: 'number',
        description:
          'Limit output to first N match groups (default: 0 = unlimited). ' +
          'A match group is a single match or a match with its context lines.',
      },
      offset: {
        type: 'number',
        description:
          'Skip first N match groups before applying head_limit (default: 0). ' +
          'Use with head_limit for pagination.',
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
    const headLimit = (params.head_limit as number) || 0;
    const offset = (params.offset as number) || 0;

    // Resolve relative paths
    if (!path.isAbsolute(searchPath)) {
      searchPath = path.join(context.workingDirectory, searchPath);
    }

    // Determine context settings (context overrides before/after if set)
    const ctxBefore = contextLines ?? beforeContext;
    const ctxAfter = contextLines ?? afterContext;

    try {
      let stdout: string;

      // Check if ripgrep is available
      try {
        await execFileAsync('which', ['rg']);

        // Build ripgrep args array (no shell interpolation)
        const args = [
          '-n', // Line numbers
          '--color=never',
          '-M', String(GREP.MAX_LINE_LENGTH), // Max line length
          '--max-count', String(GREP.MAX_MATCHES_PER_FILE), // Max matches per file
        ];

        if (caseInsensitive) {
          args.push('-i');
        }

        // Add context flags
        if (ctxBefore !== undefined && ctxBefore > 0) {
          args.push('-B', String(Math.min(ctxBefore, 10))); // Cap at 10 lines
        }
        if (ctxAfter !== undefined && ctxAfter > 0) {
          args.push('-A', String(Math.min(ctxAfter, 10))); // Cap at 10 lines
        }

        // File type filtering (more efficient than glob)
        if (fileType && FILE_TYPE_MAP[fileType]) {
          for (const ext of FILE_TYPE_MAP[fileType]) {
            args.push('-g', ext);
          }
        } else if (include) {
          args.push('-g', include);
        }

        // Common ignores
        args.push(
          '--glob', '!node_modules',
          '--glob', '!.git',
          '--glob', '!dist',
          '--glob', '!build'
        );

        // Pattern and path (no shell escaping needed with execFile)
        args.push(pattern, searchPath);

        // Execute with EAGAIN retry
        try {
          const result = await execFileAsync('rg', args, {
            maxBuffer: BASH.MAX_BUFFER,
            timeout: GREP.DEFAULT_TIMEOUT,
          });
          stdout = result.stdout;
        } catch (err: unknown) {
          if (isEagainError(err)) {
            // Retry with single thread to avoid resource exhaustion
            const retryArgs = ['-j', String(GREP.EAGAIN_RETRY_THREADS), ...args];
            const result = await execFileAsync('rg', retryArgs, {
              maxBuffer: BASH.MAX_BUFFER,
              timeout: GREP.DEFAULT_TIMEOUT,
            });
            stdout = result.stdout;
          } else {
            throw err;
          }
        }
      } catch (outerErr: unknown) {
        // If ripgrep not available or failed, try grep fallback
        const isRgNotFound = outerErr && typeof outerErr === 'object'
          && 'stderr' in outerErr
          && typeof (outerErr as { stderr: string }).stderr === 'string'
          && (outerErr as { stderr: string }).stderr.includes('which');

        // If it's a grep exit code 1 (no matches), handle below
        const exitCode = (outerErr as { code?: number })?.code;
        const stderr = (outerErr as { stderr?: string })?.stderr || '';
        if (exitCode === 1 && !stderr) {
          return { success: true, output: 'No matches found' };
        }

        if (!isRgNotFound && exitCode !== undefined) {
          // rg failed for a real reason (not "not found")
          throw outerErr;
        }

        // Fallback to grep via execFile
        const grepArgs = [
          '-r', // Recursive
          '-n', // Line numbers
          '-E', // Extended regex
        ];

        if (caseInsensitive) {
          grepArgs.push('-i');
        }

        // Add context flags
        if (ctxBefore !== undefined && ctxBefore > 0) {
          grepArgs.push('-B', String(Math.min(ctxBefore, 10)));
        }
        if (ctxAfter !== undefined && ctxAfter > 0) {
          grepArgs.push('-A', String(Math.min(ctxAfter, 10)));
        }

        // File type filtering (convert to --include patterns)
        if (fileType && FILE_TYPE_MAP[fileType]) {
          for (const ext of FILE_TYPE_MAP[fileType]) {
            grepArgs.push('--include', ext);
          }
        } else if (include) {
          grepArgs.push('--include', include);
        }

        // Exclude common directories
        grepArgs.push(
          '--exclude-dir=node_modules',
          '--exclude-dir=.git',
          '--exclude-dir=dist',
          '--exclude-dir=build'
        );

        grepArgs.push(pattern, searchPath);

        const result = await execFileAsync('grep', grepArgs, {
          maxBuffer: BASH.MAX_BUFFER,
          timeout: GREP.DEFAULT_TIMEOUT,
        });
        stdout = result.stdout;
      }

      // Apply head_limit / offset pagination by match groups
      let output: string;
      if (headLimit > 0 || offset > 0) {
        output = paginateOutput(stdout, headLimit, offset);
      } else {
        // Default: limit output lines
        const lines = stdout.split('\n').filter(Boolean);
        output = lines.slice(0, GREP.MAX_TOTAL_MATCHES).join('\n');
        if (lines.length > GREP.MAX_TOTAL_MATCHES) {
          output += `\n\n... (${lines.length - GREP.MAX_TOTAL_MATCHES} more matches)`;
        }
      }

      return {
        success: true,
        output: output || 'No matches found',
      };
    } catch (error: any) {
      // grep/rg returns exit code 1 when no matches found
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

/**
 * Paginate grep/rg output by match groups.
 * Match groups are separated by `--` lines (ripgrep/grep separator for context blocks).
 * Without context, each line is its own group.
 */
function paginateOutput(stdout: string, headLimit: number, offset: number): string {
  const rawLines = stdout.split('\n');

  // Split into match groups by `--` separator
  const groups: string[][] = [];
  let currentGroup: string[] = [];

  for (const line of rawLines) {
    if (line === '--') {
      if (currentGroup.length > 0) {
        groups.push(currentGroup);
        currentGroup = [];
      }
    } else if (line) {
      currentGroup.push(line);
    }
  }
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  // If no `--` separators found, treat each line as its own group
  if (groups.length === 1 && rawLines.filter(Boolean).length > 1 && !rawLines.includes('--')) {
    const allLines = rawLines.filter(Boolean);
    groups.length = 0;
    for (const line of allLines) {
      groups.push([line]);
    }
  }

  const totalGroups = groups.length;

  // Apply offset and limit
  const effectiveOffset = Math.min(offset, totalGroups);
  const sliced = headLimit > 0
    ? groups.slice(effectiveOffset, effectiveOffset + headLimit)
    : groups.slice(effectiveOffset);

  const shownCount = sliced.length;
  const output = sliced.map(g => g.join('\n')).join('\n--\n');

  const pagination = `(showing ${effectiveOffset + 1}-${effectiveOffset + shownCount} of ${totalGroups} matches)`;

  return output + '\n\n' + pagination;
}
