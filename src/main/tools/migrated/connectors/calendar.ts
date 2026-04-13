// ============================================================================
// Calendar (P0-6.3 Batch 6 — connectors: native ToolModule rewrite)
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
  ToolSchema,
} from '../../../protocol/tools';
import { getConnectorRegistry } from '../../../connectors';

const schema: ToolSchema = {
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

type CalendarAction = 'get_status' | 'list_calendars' | 'list_events';

interface CalendarEvent {
  calendar: string;
  title: string;
  startAtMs: number | null;
  endAtMs: number | null;
  location?: string;
  uid?: string;
}

function formatEvent(event: CalendarEvent): string {
  const start = event.startAtMs ? new Date(event.startAtMs).toLocaleString('zh-CN') : '未知开始时间';
  const end = event.endAtMs ? new Date(event.endAtMs).toLocaleString('zh-CN') : '未知结束时间';
  const location = event.location ? ` | ${event.location}` : '';
  const uid = event.uid ? `\n  uid: ${event.uid}` : '';
  return `- [${event.calendar}] ${event.title}\n  ${start} -> ${end}${location}${uid}`;
}

async function executeCalendar(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const action = args.action;
  if (typeof action !== 'string') {
    return { ok: false, error: 'action must be a string', code: 'INVALID_ARGS' };
  }
  const allowed: CalendarAction[] = ['get_status', 'list_calendars', 'list_events'];
  if (!allowed.includes(action as CalendarAction)) {
    return { ok: false, error: `Unsupported calendar action: ${action}`, code: 'INVALID_ARGS' };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  const connector = getConnectorRegistry().get('calendar');
  if (!connector) {
    return { ok: false, error: 'Calendar connector is not available.', code: 'NOT_INITIALIZED' };
  }

  try {
    const result = await connector.execute(action, args);
    ctx.logger.debug('calendar', { action });

    if (action === 'get_status') {
      const status = result.data as { connected: boolean; detail?: string; capabilities: string[] };
      return {
        ok: true,
        output: `Calendar connector: ${status.connected ? 'connected' : 'disconnected'}\n${status.detail || ''}\nCapabilities: ${status.capabilities.join(', ')}`,
        meta: { status },
      };
    }

    if (action === 'list_calendars') {
      const calendars = result.data as string[];
      return {
        ok: true,
        output: calendars.length > 0
          ? `可用日历 (${calendars.length})：\n- ${calendars.join('\n- ')}`
          : '没有找到可访问的日历。',
        meta: { count: calendars.length },
      };
    }

    // list_events
    const events = result.data as CalendarEvent[];
    return {
      ok: true,
      output: events.length > 0
        ? `日历事件 (${events.length})：\n${events.map(formatEvent).join('\n')}`
        : '没有找到匹配的日历事件。',
      meta: { count: events.length },
    };
  } catch (error) {
    return {
      ok: false,
      error: `Calendar connector failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

class CalendarHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeCalendar(args, ctx, canUseTool, onProgress);
  }
}

export const calendarModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new CalendarHandler();
  },
};
