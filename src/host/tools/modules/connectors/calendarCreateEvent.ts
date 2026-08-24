// ============================================================================
// CalendarCreateEvent (P0-6.3 Batch 6 — connectors: native ToolModule rewrite)
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
import { calendarCreateEventSchema as schema } from './calendarCreateEvent.schema';

async function executeCalendarCreateEvent(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  if (typeof args.calendar !== 'string' || args.calendar.length === 0) {
    return { ok: false, error: 'calendar must be a non-empty string', code: 'INVALID_ARGS' };
  }
  if (typeof args.title !== 'string' || args.title.length === 0) {
    return { ok: false, error: 'title must be a non-empty string', code: 'INVALID_ARGS' };
  }
  if (typeof args.start_ms !== 'number') {
    return { ok: false, error: 'start_ms must be a number', code: 'INVALID_ARGS' };
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
    const result = await connector.execute('create_event', args);
    const event = result.data as {
      uid: string;
      calendar: string;
      title: string;
      startAtMs: number | null;
      endAtMs: number | null;
      location?: string;
    };
    const undoMetadata = event.uid
      ? { undoable: true as const }
      : {
          undoable: false as const,
          undoUnavailableReason: 'Created calendar event did not return a stable uid.',
        };
    ctx.logger.debug('calendar_create_event', { calendar: event.calendar, title: event.title });
    const startText = event.startAtMs ? new Date(event.startAtMs).toLocaleString('zh-CN') : '未知';
    const endText = event.endAtMs ? new Date(event.endAtMs).toLocaleString('zh-CN') : '未知';
    const output = `已创建日历事件：\n- [${event.calendar}] ${event.title}\n- 开始：${startText}\n- 结束：${endText}${event.location ? `\n- 地点：${event.location}` : ''}`;

    return {
      ok: true,
      output,
      meta: {
        action: 'create_event',
        connector: 'calendar',
        uid: event.uid,
        ...undoMetadata,
        calendar: event.calendar,
        title: event.title,
        startAtMs: event.startAtMs,
        endAtMs: event.endAtMs,
        location: event.location,
        previewItem: {
          kind: 'calendar_event',
          title: event.title,
          subtitle: event.calendar,
          status: 'ready',
          content: {
            text: [
              `[${event.calendar}] ${event.title}`,
              `开始：${startText}`,
              `结束：${endText}`,
              event.location ? `地点：${event.location}` : null,
            ].filter(Boolean).join('\n'),
            summary: `${startText} · ${event.calendar}`,
          },
          actions: [
            { kind: 'copy', label: 'Copy' },
            { kind: 'open', label: 'Open' },
          ],
          priority: 80,
        },
        artifact: createVirtualArtifact({
          sourceTool: schema.name,
          kind: 'text',
          role: 'receipt',
          sessionId: ctx.sessionId,
          name: `已创建日历事件：${event.title}（${startText}）`,
          mimeType: 'text/markdown',
          contentLength: output.length,
          preview: output.slice(0, 500),
          metadata: {
            connector: 'calendar',
            action: 'create_event',
            uid: event.uid,
            ...undoMetadata,
            calendar: event.calendar,
            title: event.title,
            startAtMs: event.startAtMs,
            endAtMs: event.endAtMs,
          },
        }),
      },
    };
  } catch (error) {
    const failure = `Calendar create failed: ${error instanceof Error ? error.message : String(error)}`;
    return {
      ok: false,
      error: failure,
      meta: {
        action: 'create_event',
        connector: 'calendar',
        calendar: args.calendar,
        title: args.title,
        startAtMs: args.start_ms,
        failureReason: failure,
        artifact: createFailedReceiptArtifact({
          sourceTool: schema.name,
          sessionId: ctx.sessionId,
          action: 'create_event',
          name: `创建日历事件失败：${String(args.title)}`,
          error: failure,
          metadata: { connector: 'calendar', calendar: args.calendar, title: args.title },
        }),
      },
    };
  }
}

class CalendarCreateEventHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeCalendarCreateEvent(args, ctx, canUseTool, onProgress);
  }
}

export const calendarCreateEventModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new CalendarCreateEventHandler();
  },
};
