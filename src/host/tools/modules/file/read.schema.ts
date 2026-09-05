// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const readSchema: ToolSchema = {
  name: 'Read',
  description:
    'Read local files instead of Bash cat/head/tail. ' +
    'Use offset/limit for narrow ranges; avoid re-reading. ' +
    'For directories use ListDirectory or Glob. ' +
    'If the file does not exist, report that; do not create it to make the read succeed.',
  outputSchema: { type: 'string' },
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
  allowInTextForeground: true,
  readOnly: true,
  allowInPlanMode: true,
};
