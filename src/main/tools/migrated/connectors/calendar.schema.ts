// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const calendarSchema: ToolSchema = {
  name: 'calendar',
  description: `Read macOS Calendar data via a native connector.

Supported actions:
- get_status
- list_calendars
- list_events

Use this for local calendar inspection in office workflows.`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get_status', 'list_calendars', 'list_events'],
        description: 'Calendar action to perform.',
      },
      calendar: {
        type: 'string',
        description: 'Optional calendar name for list_events.',
      },
      from_ms: {
        type: 'number',
        description: 'Optional inclusive start timestamp in Unix milliseconds.',
      },
      to_ms: {
        type: 'number',
        description: 'Optional inclusive end timestamp in Unix milliseconds.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of events to return. Default: 20.',
      },
    },
    required: ['action'],
  },
  category: 'mcp',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
