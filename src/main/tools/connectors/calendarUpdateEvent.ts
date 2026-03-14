// ============================================================================
// Calendar Update Event Tool - Update a local macOS Calendar event
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { getConnectorRegistry } from '../../connectors';

export const calendarUpdateEventTool: Tool = {
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
  tags: ['planning'],
  aliases: ['update calendar event', 'edit calendar event'],
  source: 'builtin',
  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const connector = getConnectorRegistry().get('calendar');
    if (!connector) {
      return { success: false, error: 'Calendar connector is not available.' };
    }

    try {
      const result = await connector.execute('update_event', params);
      const event = result.data as {
        uid: string;
        calendar: string;
        title: string;
        startAtMs: number | null;
        endAtMs: number | null;
        location?: string;
      };

      return {
        success: true,
        output: `已更新日历事件：\n- [${event.calendar}] ${event.title}\n- uid: ${event.uid}\n- 开始：${event.startAtMs ? new Date(event.startAtMs).toLocaleString('zh-CN') : '未知'}\n- 结束：${event.endAtMs ? new Date(event.endAtMs).toLocaleString('zh-CN') : '未知'}${event.location ? `\n- 地点：${event.location}` : ''}`,
        result: event,
      };
    } catch (error) {
      return {
        success: false,
        error: `Calendar update failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
