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
import { createFailedReceiptArtifact, createVirtualArtifact } from '../../artifacts/artifactMeta';
import { calendarUpdateEventSchema as schema } from './calendarUpdateEvent.schema';
import { captureCalendarBefore } from './undoMetadata';

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
    const undoMetadata = await captureCalendarBefore(connector, args);
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
    const startText = event.startAtMs ? new Date(event.startAtMs).toLocaleString('zh-CN') : '未知';
    const output = `已更新日历事件：\n- [${event.calendar}] ${event.title}\n- uid: ${event.uid}\n- 开始：${startText}\n- 结束：${event.endAtMs ? new Date(event.endAtMs).toLocaleString('zh-CN') : '未知'}${event.location ? `\n- 地点：${event.location}` : ''}`;

    return {
      ok: true,
      output,
      meta: {
        action: 'update_event',
        connector: 'calendar',
        uid: event.uid,
        calendar: event.calendar,
        title: event.title,
        startAtMs: event.startAtMs,
        endAtMs: event.endAtMs,
        location: event.location,
        ...undoMetadata,
        artifact: createVirtualArtifact({
          sourceTool: schema.name,
          kind: 'text',
          role: 'receipt',
          sessionId: ctx.sessionId,
          name: `已更新日历事件：${event.title}（${startText}）`,
          mimeType: 'text/markdown',
          contentLength: output.length,
          preview: output.slice(0, 500),
          metadata: {
            connector: 'calendar',
            action: 'update_event',
            uid: event.uid,
            calendar: event.calendar,
            title: event.title,
            ...undoMetadata,
          },
        }),
      },
    };
  } catch (error) {
    const failure = `Calendar update failed: ${error instanceof Error ? error.message : String(error)}`;
    return {
      ok: false,
      error: failure,
      meta: {
        action: 'update_event',
        connector: 'calendar',
        calendar: args.calendar,
        uid: args.event_uid,
        title: args.title,
        failureReason: failure,
        artifact: createFailedReceiptArtifact({
          sourceTool: schema.name,
          sessionId: ctx.sessionId,
          action: 'update_event',
          name: `更新日历事件失败：${String(args.title ?? args.event_uid)}`,
          error: failure,
          metadata: { connector: 'calendar', calendar: args.calendar, uid: args.event_uid, title: args.title },
        }),
      },
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
