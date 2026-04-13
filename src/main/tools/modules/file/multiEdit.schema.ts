// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const multiEditSchema: ToolSchema = {
  name: 'Edit',
  description: `Apply multiple text replacements to the same file in a single operation. Use this instead of calling Edit repeatedly on the same file.

MUST read the file with Read first — the tool will reject edits on unread files.

How it works:
- Each edit in the edits array works like Edit: old_text must match EXACTLY
- Edits are applied sequentially — each edit operates on the result of the previous one
- If any edit fails (text not found, ambiguous match), all changes are rolled back (no partial writes)
- old_text values should reflect the ORIGINAL file content; but if earlier edits change a region, later edits must account for that

Tips:
- Order edits from bottom to top of the file to avoid line-shift issues
- Each old_text must be unique in the content at the time it is applied (or use replace_all: true)`,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to edit. File must already exist and be read first.',
      },
      edits: {
        type: 'array',
        description: 'Array of edit operations to apply sequentially.',
        items: {
          type: 'object',
          properties: {
            old_text: { type: 'string' },
            new_text: { type: 'string' },
            replace_all: { type: 'boolean' },
          },
          required: ['old_text', 'new_text'],
        },
      },
      force: { type: 'boolean', description: 'Bypass safety checks (default: false)' },
    },
    required: ['file_path', 'edits'],
  },
  category: 'fs',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
