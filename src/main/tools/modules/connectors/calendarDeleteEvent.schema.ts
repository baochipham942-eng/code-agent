// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const calendarDeleteEventSchema: ToolSchema = {
  name: 'calendar_delete_event',
  description: `Delete an existing event from macOS Calendar.

Required parameters:
- calendar
- event_uid

Use this only when the user explicitly wants to remove a real local calendar event.`,
  inputSchema: {
    type: 'object',
    properties: {
      calendar: {
        type: 'string',
        description: 'Target calendar name.',
      },
      event_uid: {
        type: 'string',
        description: 'Stable Calendar event uid.',
      },
    },
    required: ['calendar', 'event_uid'],
  },
  category: 'mcp',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
