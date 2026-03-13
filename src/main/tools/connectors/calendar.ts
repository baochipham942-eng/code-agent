// ============================================================================
// Calendar Tool - Native macOS Calendar connector
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { getConnectorRegistry } from '../../connectors';

function formatEvent(event: any): string {
  const start = event.startAtMs ? new Date(event.startAtMs).toLocaleString('zh-CN') : '未知开始时间';
  const end = event.endAtMs ? new Date(event.endAtMs).toLocaleString('zh-CN') : '未知结束时间';
  const location = event.location ? ` | ${event.location}` : '';
  return `- [${event.calendar}] ${event.title}\n  ${start} -> ${end}${location}`;
}

export const calendarTool: Tool = {
  name: 'calendar',
  description: `Read macOS Calendar data via a native connector.

Supported actions:
- get_status
- list_calendars
- list_events

Use this for local calendar inspection in office workflows.`,
  requiresPermission: true,
  permissionLevel: 'read',
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
  tags: ['planning'],
  aliases: ['calendar events', 'calendar list', 'schedule'],
  source: 'builtin',
  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const action = params.action as string;
    const connector = getConnectorRegistry().get('calendar');
    if (!connector) {
      return { success: false, error: 'Calendar connector is not available.' };
    }

    try {
      const result = await connector.execute(action, params);

      if (action === 'get_status') {
        const status = result.data as { connected: boolean; detail?: string; capabilities: string[] };
        return {
          success: true,
          output: `Calendar connector: ${status.connected ? 'connected' : 'disconnected'}\n${status.detail || ''}\nCapabilities: ${status.capabilities.join(', ')}`,
          result: status,
        };
      }

      if (action === 'list_calendars') {
        const calendars = result.data as string[];
        return {
          success: true,
          output: calendars.length > 0
            ? `可用日历 (${calendars.length})：\n- ${calendars.join('\n- ')}`
            : '没有找到可访问的日历。',
          result: calendars,
        };
      }

      if (action === 'list_events') {
        const events = result.data as any[];
        return {
          success: true,
          output: events.length > 0
            ? `日历事件 (${events.length})：\n${events.map(formatEvent).join('\n')}`
            : '没有找到匹配的日历事件。',
          result: events,
          metadata: { count: events.length },
        };
      }

      return { success: false, error: `Unsupported calendar action: ${action}` };
    } catch (error) {
      return {
        success: false,
        error: `Calendar connector failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
