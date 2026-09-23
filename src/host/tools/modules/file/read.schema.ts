// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const readSchema: ToolSchema = {
  name: 'Read',
  description:
    'Read a local text file with line numbers. Prefer this over Bash cat/head/tail. ' +
    'When the user wants one field, a version, a name, or any single config value, do not read the whole file: Grep that key first, then Read only a short window (set limit, for example 20, and offset to the matching line). ' +
    'Omitting limit reads up to the default 2000 lines and pulls in a short file such as package.json in full — that is the wrong call for a single value. ' +
    'offset is the 1-indexed first line (default 1). limit is how many lines (default 2000). ' +
    'The same offset and limit are also accepted inside file_path as "<path> offset=N limit=N" or "<path> lines N-M"; that is this syntax, not a second one. Prefer the offset and limit fields. ' +
    'If the window stops before the end of the file, the result says how many lines were shown, how many remain unread, and the next offset. Unread lines were not returned. ' +
    'For directories use ListDirectory or Glob. If the file does not exist, report that; do not create it to make the read succeed.',
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description:
          'Path to the file (absolute, or relative to the working directory); ~ is expanded. ' +
          'The same offset/limit may be embedded here as "<path> offset=N limit=N" or "<path> lines N-M". Prefer the offset and limit fields.',
      },
      offset: {
        type: 'number',
        description:
          'First line to read, 1-indexed. Default 1. For one field or a version, set this to the Grep hit instead of reading from line 1. Past the end of the file returns empty content.',
      },
      limit: {
        type: 'number',
        description:
          'How many lines to read. Default 2000. For one field, a version, or a single config value, set a small limit (about 20) instead of omitting it.',
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
