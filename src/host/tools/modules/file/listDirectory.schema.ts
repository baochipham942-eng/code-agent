// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const listDirectorySchema: ToolSchema = {
  name: 'ListDirectory',
  description: `List directory contents as a tree structure.

Use for: understanding project layout, browsing directory contents.

For finding specific files by name pattern, use Glob instead — it is faster and supports recursive matching (e.g., "**/*.ts").
For searching file contents, use Grep.`,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目录路径，默认 workingDir' },
      recursive: { type: 'boolean', description: '是否递归' },
      max_depth: { type: 'number', description: '递归最大深度，默认 3' },
      offset: { type: 'number', description: 'Zero-based result offset for pagination. Default: 0.' },
      limit: { type: 'number', description: 'Maximum entries to return in this page. Default: 200, max: 1000.' },
      sort: {
        type: 'string',
        enum: ['path', 'name', 'type', 'size'],
        description: 'Sort order for flattened entries. Default: path.',
      },
      respect_gitignore: {
        type: 'boolean',
        description: 'When true, best-effort respect top-level .gitignore entries in addition to built-in ignored dirs. Default: true.',
      },
    },
    required: [],
  },
  category: 'fs',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
