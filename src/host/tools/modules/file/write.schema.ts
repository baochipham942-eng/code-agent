// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const writeSchema: ToolSchema = {
  name: 'Write',
  description:
    'Writes a file to the local filesystem. Overwrites existing files. ' +
    'IMPORTANT: You MUST read the file first before writing to it — use Edit for modifications ' +
    'instead, which only sends the diff. Use Write for new files or complete rewrites. ' +
    'For large generated artifacts such as full HTML/CSS/JS apps, games, documents, or data files, ' +
    'prefer Append chunks when the content is very large. Complete medium-sized artifacts are accepted ' +
    'in one Write call when the whole content is already available.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description:
          'Absolute path to create or overwrite; ~ is expanded. Parent directories are created automatically.',
      },
      content: {
        type: 'string',
        description:
          'Complete file content — this REPLACES the whole file, it does not append. '
          + 'A medium-sized single-file app in one Write is fine; for artifacts too large for one call, '
          + 'Write the first chunk then Append the rest.',
      },
      force: {
        type: 'boolean',
        description:
          'Bypass the existing-file pre-read and stale digest gate. Only valid for overwrites when force_reason is provided.',
      },
      force_reason: {
        type: 'string',
        description:
          'Required when force=true for overwriting an existing file. Explain why bypassing the read/digest safety gate is intentional.',
      },
    },
    required: ['file_path', 'content'],
  },
  category: 'fs',
  permissionLevel: 'write',
  pathAuthority: [{ kind: 'path', pathParameter: 'file_path' }],
  readOnly: false,
  allowInPlanMode: false,
};
