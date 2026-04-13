// ============================================================================
// CalendarUpdateEvent (P0-6.3 Batch 6 — connectors: native ToolModule rewrite)
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
import { calendarUpdateEventSchema as schema } from './calendarUpdateEvent.schema';

async function executeCalendarUpdateEvent(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  if (typeof args.calendar !== 'string' || args.calendar.length === 0) {
    return { ok: false, error: 'calendar must be a non-empty string', code: 'INVALID_ARGS' };
  }
  if (typeof args.event_uid !== 'string' || args.event_uid.length === 0) {
    return { ok: false, error: 'event_uid must be a non-empty string', code: 'INVALID_ARGS' };
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
    const result = await connector.execute('update_event', args);
    const event = result.data as {
      uid: string;
      calendar: string;
      title: string;
      startAtMs: number | null;
      endAtMs: number | null;
      location?: string;
    };
    ctx.logger.debug('calendar_update_event', { uid: event.uid, calendar: event.calendar });

    return {
      ok: true,
      output: `已更新日历事件：\n- [${event.calendar}] ${event.title}\n- uid: ${event.uid}\n- 开始：${event.startAtMs ? new Date(event.startAtMs).toLocaleString('zh-CN') : '未知'}\n- 结束：${event.endAtMs ? new Date(event.endAtMs).toLocaleString('zh-CN') : '未知'}${event.location ? `\n- 地点：${event.location}` : ''}`,
      meta: { uid: event.uid, calendar: event.calendar },
    };
  } catch (error) {
    return {
      ok: false,
      error: `Calendar update failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

class CalendarUpdateEventHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeCalendarUpdateEvent(args, ctx, canUseTool, onProgress);
  }
}

export const calendarUpdateEventModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new CalendarUpdateEventHandler();
  },
};
