// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const memoryReadSchema: ToolSchema = {
  name: 'MemoryRead',
  description:
    'Read a memory detail file from the persistent file-based memory system. ' +
    'Use after checking INDEX.md (injected in system prompt) to load specific memories relevant to the current task.',
  inputSchema: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: 'Memory filename to read (e.g., "user_role.md"). Must end with .md.',
      },
    },
    required: ['filename'],
  },
  category: 'fs',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
