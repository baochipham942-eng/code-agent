// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const calendarCreateEventSchema: ToolSchema = {
  name: 'calendar_create_event',
  description: `Create a new event in macOS Calendar via the native connector.

Required parameters:
- calendar
- title
- start_ms

Optional parameters:
- end_ms
- location

Use this only when the user wants to create a real local calendar event.`,
  inputSchema: {
    type: 'object',
    properties: {
      calendar: {
        type: 'string',
        description: 'Target calendar name.',
      },
      title: {
        type: 'string',
        description: 'Event title.',
      },
      start_ms: {
        type: 'number',
        description: 'Event start time in Unix milliseconds.',
      },
      end_ms: {
        type: 'number',
        description: 'Event end time in Unix milliseconds. Defaults to start + 30 minutes.',
      },
      location: {
        type: 'string',
        description: 'Optional event location.',
      },
    },
    required: ['calendar', 'title', 'start_ms'],
  },
  category: 'mcp',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
