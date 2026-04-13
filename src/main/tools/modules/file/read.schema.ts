// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const readSchema: ToolSchema = {
  name: 'Read',
  description:
    'Reads a file from the local filesystem. Use this instead of Bash cat/head/tail. ' +
    'Supports offset and limit for large files. Cannot read directories — use ListDirectory or Glob for that.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description:
          'Absolute path to the file. MUST be a string, not an object. ' +
          'Examples: "/Users/name/project/src/index.ts", "/home/user/config.json". ' +
          'Supports ~ for home directory: "~/Documents/file.txt". ' +
          'Do NOT include parameters like offset or limit in this string.',
      },
      offset: {
        type: 'number',
        description:
          'Line number to start reading from. Integer, 1-indexed (first line is 1, not 0). ' +
          'Default: 1. Example: offset=100 starts reading from line 100. ' +
          'If offset exceeds total lines, returns empty content.',
      },
      limit: {
        type: 'number',
        description:
          'Maximum number of lines to read. Integer, must be positive. ' +
          'Default: 2000. Example: limit=50 reads up to 50 lines. ' +
          'Combined with offset: offset=100, limit=50 reads lines 100-149.',
      },
    },
    required: ['file_path'],
  },
  category: 'fs',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
