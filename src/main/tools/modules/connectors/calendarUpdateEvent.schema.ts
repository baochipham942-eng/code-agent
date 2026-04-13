// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const calendarUpdateEventSchema: ToolSchema = {
  name: 'calendar_update_event',
  description: `Update an existing event in macOS Calendar via the native connector.

Required parameters:
- calendar
- event_uid

Optional parameters:
- title
- start_ms
- end_ms
- location

Use this only when the user wants to modify a real local calendar event.`,
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
      title: {
        type: 'string',
        description: 'Optional updated title.',
      },
      start_ms: {
        type: 'number',
        description: 'Optional updated start time in Unix milliseconds.',
      },
      end_ms: {
        type: 'number',
        description: 'Optional updated end time in Unix milliseconds.',
      },
      location: {
        type: 'string',
        description: 'Optional updated location. Pass an empty string to clear it.',
      },
    },
    required: ['calendar', 'event_uid'],
  },
  category: 'mcp',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
