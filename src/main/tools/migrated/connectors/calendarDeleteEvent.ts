// ============================================================================
// CalendarDeleteEvent (P0-6.3 Batch 6 — connectors: native ToolModule rewrite)
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
  name: 'calendar_delete_event',
  description: `Delete an existing event from macOS Calendar.

Required parameters:
- calendar
- event_uid

Use this only when the user explicitly wants to remove a real local calendar event.`,
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
  category: 'mcp',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};

async function executeCalendarDeleteEvent(
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
    const result = await connector.execute('delete_event', args);
    const event = result.data as {
      uid: string;
      calendar: string;
      title: string;
      deleted: boolean;
    };
    ctx.logger.debug('calendar_delete_event', { uid: event.uid, calendar: event.calendar });

    return {
      ok: true,
      output: `已删除日历事件：\n- [${event.calendar}] ${event.title}\n- uid: ${event.uid}`,
      meta: { uid: event.uid, deleted: event.deleted },
    };
  } catch (error) {
    return {
      ok: false,
      error: `Calendar delete failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

class CalendarDeleteEventHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeCalendarDeleteEvent(args, ctx, canUseTool, onProgress);
  }
}

export const calendarDeleteEventModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new CalendarDeleteEventHandler();
  },
};
