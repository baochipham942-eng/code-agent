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
        description: 'Regex pattern. Escape . * + ? [ ] ( ) { } | \\\\ ^ $ when matching them literally.',
      },
      path: {
        type: 'string',
        description: 'File or directory to search in. Default: current working directory.',
      },
      include: {
        type: 'string',
        description: 'Glob filter for which files to search, e.g. "*.{js,jsx}". Default: all text files.',
      },
      case_insensitive: {
        type: 'boolean',
        description: 'Case-insensitive matching. Default: false.',
      },
      type: {
        type: 'string',
        description:
          'Filter by file type — cheaper than an include glob. One of: js, ts, jsx, tsx, py, rust, go, '
          + 'java, c, cpp, css, html, json, yaml, md, xml, sql, sh, ruby, php, swift, kotlin.',
      },
      before_context: {
        type: 'number',
        description: 'Lines to show before each match (grep -B).',
      },
      after_context: {
        type: 'number',
        description: 'Lines to show after each match (grep -A).',
      },
      context: {
        type: 'number',
        description: 'Lines to show on both sides (grep -C); sets before_context and after_context together.',
      },
      head_limit: {
        type: 'number',
        description:
          'Cap the number of match groups returned (default 0 = unlimited). A match group is one match '
          + 'plus its context lines. Pair with offset to page through results.',
      },
      offset: {
        type: 'number',
        description: 'Skip this many match groups first (default 0). Use the returned nextOffset for the next page.',
      },
    },
    required: ['pattern'],
  },
  category: 'fs',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
