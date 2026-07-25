// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const requestDirectorySchema: ToolSchema = {
  name: 'request_directory',
  description: `Ask the user for permission to access a directory that is outside the current Project Sources (workspace scope).

Use this when a task needs to read or write a folder you don't currently have access to, instead of failing the operation and giving up. The user reviews and approves/denies the request from the approval inbox — this can take a while, so continue other work if possible while waiting.

If approved, the directory is added as an additional Project Source starting with the NEXT message in this conversation (not the current tool call) — after approval, tell the user you now have access and ask them to continue, or state clearly that you'll pick the task back up next turn.

Only request 'read_write' when the task actually needs to write into that directory; default to 'read_only'.`,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute (or CWD-relative) path to the directory you need access to. Must already exist.',
      },
      reason: {
        type: 'string',
        description: 'Short human-readable reason for the request, shown to the user on the approval card.',
      },
      access: {
        type: 'string',
        enum: ['read_only', 'read_write'],
        description: 'Access level requested. Default: read_only.',
      },
    },
    required: ['path', 'reason'],
  },
  category: 'fs',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
