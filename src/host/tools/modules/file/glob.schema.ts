// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const globSchema: ToolSchema = {
  name: 'Glob',
  description:
    'Fast file pattern matching tool. Use this to find files by name patterns ' +
    "(e.g. '**/*.ts', 'src/**/*.tsx'). Returns matching file paths. " +
    'Use this instead of Bash find or ls commands.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern, e.g. "src/**/*.tsx". ** matches recursively, * matches one level.',
      },
      path: {
        type: 'string',
        description: 'Directory to search in — absolute, relative, or ~. Default: current working directory.',
      },
      offset: {
        type: 'number',
        description: 'Zero-based result offset for pagination. Default: 0.',
      },
      limit: {
        type: 'number',
        description: 'Maximum results to return in this page. Default: 200, max: 1000.',
      },
      sort: {
        type: 'string',
        enum: ['path', 'name', 'mtime', 'size'],
        description: 'Sort order for results. Default: path. mtime and size sort descending.',
      },
      respect_gitignore: {
        type: 'boolean',
        description: 'When true, best-effort respect top-level .gitignore entries in addition to built-in ignores. Default: true.',
      },
    },
    required: ['pattern'],
  },
  category: 'fs',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
