// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const readClipboardSchema: ToolSchema = {
  name: 'read_clipboard',
  description: `Read the contents of the system clipboard.

Supports text and image content. Returns base64 PNG for images.`,
  inputSchema: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        enum: ['text', 'image', 'auto'],
        description: 'Format to read (default: auto)',
      },
    },
    required: [],
  },
  category: 'fs',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
