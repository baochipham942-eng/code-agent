// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const remindersDeleteSchema: ToolSchema = {
  name: 'reminders_delete',
  description: `Delete an existing reminder from macOS Reminders.

Required parameters:
- list
- reminder_id

Use this only when the user explicitly wants to remove a real local reminder.`,
  inputSchema: {
    type: 'object',
    properties: {
      list: {
        type: 'string',
        description: 'Target reminder list name.',
      },
      reminder_id: {
        type: 'string',
        description: 'Stable reminder id.',
      },
    },
    required: ['list', 'reminder_id'],
  },
  category: 'mcp',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
