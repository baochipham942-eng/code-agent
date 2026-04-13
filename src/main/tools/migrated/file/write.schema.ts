// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const writeSchema: ToolSchema = {
  name: 'Write',
  description:
    'Writes a file to the local filesystem. Overwrites existing files. ' +
    'IMPORTANT: You MUST read the file first before writing to it — use Edit for modifications ' +
    'instead, which only sends the diff. Only use Write for new files or complete rewrites.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description:
          'Absolute path where the file will be created or overwritten. MUST be a string. ' +
          'Examples: "/Users/name/project/src/new-file.ts", "/home/user/config.json". ' +
          'Supports ~ for home directory: "~/Documents/file.txt". ' +
          'Parent directories will be created automatically if they do not exist.',
      },
      content: {
        type: 'string',
        description:
          'The complete file content to write. MUST be a string (not an object or array). ' +
          'This will REPLACE the entire file content, not append. ' +
          'For JSON files, use JSON.stringify() format. ' +
          'For code files, include proper indentation and newlines.',
      },
    },
    required: ['file_path', 'content'],
  },
  category: 'fs',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
