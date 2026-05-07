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
} from '../../../protocol/tools';
import { getConnectorRegistry } from '../../../connectors';
import { createVirtualArtifact } from '../../artifacts/artifactMeta';
import { calendarSchema as schema } from './calendar.schema';

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

function buildCalendarMeta(
  ctx: ToolContext,
  action: string,
  output: string,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return {
    action,
    connector: 'calendar',
    ...metadata,
    artifact: createVirtualArtifact({
      sourceTool: schema.name,
      kind: 'text',
      sessionId: ctx.sessionId,
      name: `calendar-${action}`,
      mimeType: 'text/markdown',
      contentLength: output.length,
      preview: output.slice(0, 500),
      metadata: {
        connector: 'calendar',
        action,
        ...metadata,
      },
    }),
  };
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
    if (action === 'get_status') {
      const status = {
        connected: false,
        detail: 'Calendar connector is not configured in this runtime.',
        capabilities: [] as string[],
        unavailable: true,
      };
      const output = `Calendar connector: unavailable\n${status.detail}\nCapabilities: none`;
      return {
        ok: true,
        output,
        meta: buildCalendarMeta(ctx, action, output, { status }),
      };
    }
    return { ok: false, error: 'Calendar connector is not available.', code: 'NOT_INITIALIZED' };
  }

  try {
    const result = await connector.execute(action, args);
    ctx.logger.debug('calendar', { action });

    if (action === 'get_status') {
      const status = result.data as { connected: boolean; detail?: string; capabilities: string[] };
      const output = `Calendar connector: ${status.connected ? 'connected' : 'disconnected'}\n${status.detail || ''}\nCapabilities: ${status.capabilities.join(', ')}`;
      return {
        ok: true,
        output,
        meta: buildCalendarMeta(ctx, action, output, { status }),
      };
    }

    if (action === 'list_calendars') {
      const calendars = result.data as string[];
      const output = calendars.length > 0
        ? `可用日历 (${calendars.length})：\n- ${calendars.join('\n- ')}`
        : '没有找到可访问的日历。';
      return {
        ok: true,
        output,
        meta: buildCalendarMeta(ctx, action, output, { count: calendars.length, calendars }),
      };
    }

    // list_events
    const events = result.data as CalendarEvent[];
    const output = events.length > 0
      ? `日历事件 (${events.length})：\n${events.map(formatEvent).join('\n')}`
      : '没有找到匹配的日历事件。';
    return {
      ok: true,
      output,
      meta: buildCalendarMeta(ctx, action, output, { count: events.length, events }),
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
