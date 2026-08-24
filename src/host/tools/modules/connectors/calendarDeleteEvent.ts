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
} from '../../../protocol/tools';
import { getConnectorRegistry } from '../../../connectors';
import { createFailedReceiptArtifact, createVirtualArtifact } from '../../artifacts/artifactMeta';
import { calendarDeleteEventSchema as schema } from './calendarDeleteEvent.schema';
import { captureCalendarBefore } from './undoMetadata';

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
    const undoMetadata = await captureCalendarBefore(connector, args);
    const result = await connector.execute('delete_event', args);
    const event = result.data as {
      uid: string;
      calendar: string;
      title: string;
      deleted: boolean;
    };
    ctx.logger.debug('calendar_delete_event', { uid: event.uid, calendar: event.calendar });
    const output = `已删除日历事件：\n- [${event.calendar}] ${event.title}\n- uid: ${event.uid}`;

    return {
      ok: true,
      output,
      meta: {
        action: 'delete_event',
        connector: 'calendar',
        uid: event.uid,
        calendar: event.calendar,
        title: event.title,
        deleted: event.deleted,
        ...undoMetadata,
        artifact: createVirtualArtifact({
          sourceTool: schema.name,
          kind: 'text',
          role: 'receipt',
          sessionId: ctx.sessionId,
          name: `已删除日历事件：${event.title}`,
          mimeType: 'text/markdown',
          contentLength: output.length,
          preview: output.slice(0, 500),
          metadata: {
            connector: 'calendar',
            action: 'delete_event',
            uid: event.uid,
            deleted: event.deleted,
            ...undoMetadata,
          },
        }),
      },
    };
  } catch (error) {
    const failure = `Calendar delete failed: ${error instanceof Error ? error.message : String(error)}`;
    return {
      ok: false,
      error: failure,
      meta: {
        action: 'delete_event',
        connector: 'calendar',
        calendar: args.calendar,
        uid: args.event_uid,
        failureReason: failure,
        artifact: createFailedReceiptArtifact({
          sourceTool: schema.name,
          sessionId: ctx.sessionId,
          action: 'delete_event',
          name: `删除日历事件失败：${String(args.event_uid)}`,
          error: failure,
          metadata: { connector: 'calendar', calendar: args.calendar, uid: args.event_uid },
        }),
      },
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
