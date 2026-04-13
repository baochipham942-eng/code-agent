// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const grepSchema: ToolSchema = {
  name: 'Grep',
  description:
    'Searches file contents using regex patterns. Use this instead of Bash grep or rg. ' +
    'Supports regex syntax, file type filtering, glob patterns, and context lines. ' +
    'Use context params (before_context/after_context/context) to see surrounding lines. ' +
    'Use head_limit + offset for pagination by match group.',
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
          'Examples: "/Users/name/project/src", "./src/components". ' +
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
          'Example: with case_insensitive=true, "error" matches "Error", "ERROR".',
      },
      type: {
        type: 'string',
        description:
          'Filter by file type. More efficient than include glob. ' +
          'Supported types: js, ts, jsx, tsx, py, rust, go, java, c, cpp, css, html, ' +
          'json, yaml, md, xml, sql, sh, ruby, php, swift, kotlin. ' +
          'Example: type="ts" searches only TypeScript files.',
      },
      before_context: {
        type: 'number',
        description:
          'Number of lines to show BEFORE each match (like grep -B). ' +
          'Useful for seeing context leading up to a match.',
      },
      after_context: {
        type: 'number',
        description:
          'Number of lines to show AFTER each match (like grep -A). ' +
          'Useful for seeing what follows a match.',
      },
      context: {
        type: 'number',
        description:
          'Number of lines to show BEFORE and AFTER each match (like grep -C). ' +
          'Shorthand for setting both before_context and after_context.',
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
  category: 'fs',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
