// ============================================================================
// Calendar Delete Event Tool - Delete a local macOS Calendar event
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { getConnectorRegistry } from '../../connectors';

export const calendarDeleteEventTool: Tool = {
  name: 'calendar_delete_event',
  description: `Delete an existing event from macOS Calendar.

Required parameters:
- calendar
- event_uid

Use this only when the user explicitly wants to remove a real local calendar event.`,
  requiresPermission: true,
  permissionLevel: 'write',
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
  tags: ['planning'],
  aliases: ['delete calendar event', 'remove calendar event'],
  source: 'builtin',
  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const connector = getConnectorRegistry().get('calendar');
    if (!connector) {
      return { success: false, error: 'Calendar connector is not available.' };
    }

    try {
      const result = await connector.execute('delete_event', params);
      const event = result.data as {
        uid: string;
        calendar: string;
        title: string;
        deleted: boolean;
      };

      return {
        success: true,
        output: `已删除日历事件：\n- [${event.calendar}] ${event.title}\n- uid: ${event.uid}`,
        result: event,
      };
    } catch (error) {
      return {
        success: false,
        error: `Calendar delete failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
