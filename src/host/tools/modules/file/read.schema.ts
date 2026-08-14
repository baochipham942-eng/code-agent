// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const readSchema: ToolSchema = {
  name: 'Read',
  description:
    'Reads a file from the local filesystem. Use this instead of Bash cat/head/tail. ' +
    'Supports offset and limit for large files; prefer narrow ranges after the first read instead of re-reading the same file. ' +
    'Cannot read directories — use ListDirectory or Glob for that.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description:
          'Absolute path to the file; ~ is expanded. Put only the path here — offset/limit are separate parameters.',
      },
      offset: {
        type: 'number',
        description: 'First line to read, 1-indexed. Default 1. Past the end of the file returns empty content.',
      },
      limit: {
        type: 'number',
        description: 'How many lines to read. Default 2000.',
      },
    },
    required: ['file_path'],
  },
  category: 'fs',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
