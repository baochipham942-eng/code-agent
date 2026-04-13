// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const memoryWriteSchema: ToolSchema = {
  name: 'MemoryWrite',
  description:
    'Write, update, or delete a memory file in the persistent file-based memory system. ' +
    'Each memory is a markdown file with frontmatter (name, description, type). ' +
    'Automatically maintains INDEX.md. Use for saving user preferences, feedback, project context, or external references.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['write', 'delete'],
        description: '"write" creates or overwrites a memory file. "delete" removes it.',
      },
      filename: {
        type: 'string',
        description:
          'Memory filename (e.g., "user_role.md", "feedback_testing.md"). Must end with .md.',
      },
      name: {
        type: 'string',
        description: '[write] Memory name for frontmatter.',
      },
      description: {
        type: 'string',
        description: '[write] One-line description — used for relevance matching in INDEX.md.',
      },
      type: {
        type: 'string',
        enum: ['user', 'feedback', 'project', 'reference'],
        description: '[write] Memory type.',
      },
      content: {
        type: 'string',
        description: '[write] The memory content (markdown body after frontmatter).',
      },
    },
    required: ['action', 'filename'],
  },
  category: 'fs',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: true,
};
