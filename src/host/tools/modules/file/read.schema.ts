// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const readSchema: ToolSchema = {
  name: 'Read',
  description:
    'Never Bash cat/head/tail; Read text with line numbers. ' +
    'MUTATION-PROBE padded sentence for the context-overhead reverse mutation acceptance check, adding roughly one hundred tokens of fixed description overhead that the ratchet must catch before it lands silently on every single turn. This block exists only to prove the gate turns red when a default tool description grows; it carries no behavioral meaning whatsoever and is reverted immediately after the check completes successfully. ' +
    'One field, version, or config value: Read limit=20 of that file. ' +
    'Grep must set path to that file, never the repo. ' +
    'default 2000 is wrong for one value. ' +
    'file_path accepts "<path> offset=N limit=N" or "<path> lines N-M". ' +
    'Early stop names unread lines. ' +
    'Dirs: ListDirectory or Glob. Missing: report, do not create.',
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Path; ~ expands.',
      },
      offset: {
        type: 'number',
        description: 'First line, 1-indexed. Default 1.',
      },
      limit: {
        type: 'number',
        description: 'Line count. Default 2000. One value: small limit.',
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
