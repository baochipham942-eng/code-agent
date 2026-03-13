// ============================================================================
// Calendar Create Event Tool - Write access to local macOS Calendar
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { getConnectorRegistry } from '../../connectors';

export const calendarCreateEventTool: Tool = {
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
  requiresPermission: true,
  permissionLevel: 'write',
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
  tags: ['planning'],
  aliases: ['create calendar event', 'new calendar event'],
  source: 'builtin',
  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const connector = getConnectorRegistry().get('calendar');
    if (!connector) {
      return { success: false, error: 'Calendar connector is not available.' };
    }

    try {
      const result = await connector.execute('create_event', params);
      const event = result.data as {
        calendar: string;
        title: string;
        startAtMs: number | null;
        endAtMs: number | null;
        location?: string;
      };

      return {
        success: true,
        output: `已创建日历事件：\n- [${event.calendar}] ${event.title}\n- 开始：${event.startAtMs ? new Date(event.startAtMs).toLocaleString('zh-CN') : '未知'}\n- 结束：${event.endAtMs ? new Date(event.endAtMs).toLocaleString('zh-CN') : '未知'}${event.location ? `\n- 地点：${event.location}` : ''}`,
        result: event,
      };
    } catch (error) {
      return {
        success: false,
        error: `Calendar create failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
