// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const remindersUpdateSchema: ToolSchema = {
  name: 'reminders_update',
  description: `Update an existing reminder in macOS Reminders via the native connector.

Required parameters:
- list
- reminder_id

Optional parameters:
- title
- notes
- remind_at_ms
- clear_remind_at
- completed

Use this when the user wants to edit or complete a real local reminder.`,
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
      title: {
        type: 'string',
        description: 'Optional updated reminder title.',
      },
      notes: {
        type: 'string',
        description: 'Optional updated notes. Pass an empty string to clear it.',
      },
      remind_at_ms: {
        type: 'number',
        description: 'Optional updated reminder time in Unix milliseconds.',
      },
      clear_remind_at: {
        type: 'boolean',
        description: 'Set true to clear an existing reminder time.',
      },
      completed: {
        type: 'boolean',
        description: 'Set true to mark complete, false to reopen.',
      },
    },
    required: ['list', 'reminder_id'],
  },
  category: 'mcp',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
