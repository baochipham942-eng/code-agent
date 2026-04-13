// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const remindersSchema: ToolSchema = {
  name: 'reminders',
  description: `Read macOS Reminders data via a native connector.

Supported actions:
- get_status
- list_lists
- list_reminders

Use this for local reminders inspection in office workflows.`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get_status', 'list_lists', 'list_reminders'],
        description: 'Reminders action to perform.',
      },
      list: {
        type: 'string',
        description: 'Optional reminder list name for list_reminders.',
      },
      include_completed: {
        type: 'boolean',
        description: 'Whether to include completed reminders.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of reminders to return. Default: 20.',
      },
    },
    required: ['action'],
  },
  category: 'mcp',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
