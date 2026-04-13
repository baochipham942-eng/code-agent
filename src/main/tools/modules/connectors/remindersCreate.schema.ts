// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const remindersCreateSchema: ToolSchema = {
  name: 'reminders_create',
  description: `Create a new reminder in macOS Reminders via the native connector.

Required parameters:
- list
- title

Optional parameters:
- notes
- remind_at_ms

Use this only when the user wants to create a real local reminder.`,
  inputSchema: {
    type: 'object',
    properties: {
      list: {
        type: 'string',
        description: 'Target reminder list name.',
      },
      title: {
        type: 'string',
        description: 'Reminder title.',
      },
      notes: {
        type: 'string',
        description: 'Optional reminder notes/body.',
      },
      remind_at_ms: {
        type: 'number',
        description: 'Optional reminder time in Unix milliseconds.',
      },
    },
    required: ['list', 'title'],
  },
  category: 'mcp',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
