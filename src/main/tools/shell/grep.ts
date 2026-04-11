// ============================================================================
// Grep Tool - Search file contents
// ============================================================================
// Enhanced with context lines (-A/-B/-C), file type filtering (--type),
// EAGAIN retry, execFile (no shell injection), head_limit/offset pagination
// ============================================================================

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import type { Tool, ToolContext, ToolExecutionResult } from '../types';
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

/** Cached rg binary path (resolved once, reused) */
let rgBinaryPath: string | null | undefined; // undefined = not yet checked

/**
 * Find the ripgrep binary. execFile cannot resolve shell aliases,
 * so we check common locations.
 */
function findRgBinary(): string | null {
  if (rgBinaryPath !== undefined) return rgBinaryPath;

  const { existsSync } = require('fs') as typeof import('fs');
  const candidates = [
    // Homebrew
    '/opt/homebrew/bin/rg',
    '/usr/local/bin/rg',
    // Claude Code vendor
    `${process.env.HOME}/.npm-global/lib/node_modules/@anthropic-ai/claude-code/vendor/ripgrep/arm64-darwin/rg`,
    `${process.env.HOME}/.npm-global/lib/node_modules/@anthropic-ai/claude-code/vendor/ripgrep/x64-darwin/rg`,
    `${process.env.HOME}/.npm-global/lib/node_modules/@anthropic-ai/claude-code/vendor/ripgrep/x64-linux/rg`,
    // System
    '/usr/bin/rg',
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      rgBinaryPath = candidate;
      return rgBinaryPath;
    }
  }

  rgBinaryPath = null;
  return null;
}

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

interface RgResult {
  found: boolean;     // rg ran and found matches
  noMatches: boolean; // rg ran but found no matches
  stdout: string;
}

/**
 * Try running ripgrep directly. Returns:
 * - { found: true, stdout } if matches found
 * - { noMatches: true } if rg ran but found nothing
 * - { found: false, noMatches: false } if rg is not available (fallback to grep)
 */
async function tryRipgrep(
  pattern: string,
  searchPath: string,
  caseInsensitive: boolean,
  ctxBefore: number | undefined,
  ctxAfter: number | undefined,
  fileType: string | undefined,
  include: string | undefined,
): Promise<RgResult> {
  const args = [
    '-n', '--color=never',
    '-M', String(GREP.MAX_LINE_LENGTH),
    '--max-count', String(GREP.MAX_MATCHES_PER_FILE),
  ];

  if (caseInsensitive) args.push('-i');
  if (ctxBefore !== undefined && ctxBefore > 0) args.push('-B', String(Math.min(ctxBefore, 10)));
  if (ctxAfter !== undefined && ctxAfter > 0) args.push('-A', String(Math.min(ctxAfter, 10)));

  if (fileType && FILE_TYPE_MAP[fileType]) {
    for (const ext of FILE_TYPE_MAP[fileType]) args.push('-g', ext);
  } else if (include) {
    args.push('-g', include);
  }

  args.push('--glob', '!node_modules', '--glob', '!.git', '--glob', '!dist', '--glob', '!build');
  args.push(pattern, searchPath);

  const rgPath = findRgBinary();
  if (!rgPath) {
    return { found: false, noMatches: false, stdout: '' };
  }

  try {
    const result = await execFileAsync(rgPath, args, {
      maxBuffer: BASH.MAX_BUFFER,
      timeout: GREP.DEFAULT_TIMEOUT,
    });
    return { found: true, noMatches: false, stdout: result.stdout };
  } catch (err: unknown) {
    const e = err as { code?: number | string; stderr?: string; message?: string };

    // EAGAIN: retry with single thread
    if (isEagainError(err)) {
      try {
        const retryArgs = ['-j', String(GREP.EAGAIN_RETRY_THREADS), ...args];
        const result = await execFileAsync(rgPath, retryArgs, {
          maxBuffer: BASH.MAX_BUFFER,
          timeout: GREP.DEFAULT_TIMEOUT,
        });
        return { found: true, noMatches: false, stdout: result.stdout };
      } catch (retryErr: unknown) {
        const re = retryErr as { code?: number | string; stderr?: string };
        if (re.code === 1 && !re.stderr) {
          return { found: false, noMatches: true, stdout: '' };
        }
        throw retryErr;
      }
    }

    // Exit code 1 + no stderr = no matches (rg IS available, just no results)
    if (e.code === 1 && !e.stderr) {
      return { found: false, noMatches: true, stdout: '' };
    }

    // ENOENT / EACCES = rg not installed — signal fallback to grep
    if (e.code === 'ENOENT' || (e.message?.includes('ENOENT'))) {
      return { found: false, noMatches: false, stdout: '' };
    }

    // Other real errors (bad pattern, etc.)
    throw err;
  }
}

export const grepTool: Tool = {
  name: 'Grep',
  description: `Searches file contents using regex patterns. Use this instead of Bash grep or rg. Supports regex syntax, file type filtering, glob patterns, and multiple output modes (content, files_with_matches, count). Use context params (-A/-B/-C) to see surrounding lines.`,
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

      // Try ripgrep first, fall back to grep
      const rgResult = await tryRipgrep(
        pattern, searchPath, caseInsensitive, ctxBefore, ctxAfter, fileType, include
      );

      if (rgResult.found) {
        stdout = rgResult.stdout;
      } else if (rgResult.noMatches) {
        return { success: true, output: 'No matches found' };
      } else {
        // rg not available — fallback to grep via execFile
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
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      // grep/rg returns exit code 1 when no matches found
      if ((error as Record<string, unknown>).code === 1 && !(error as Record<string, unknown>).stderr) {
        return {
          success: true,
          output: 'No matches found',
        };
      }
      return {
        success: false,
        error: errMsg || 'Search failed',
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
