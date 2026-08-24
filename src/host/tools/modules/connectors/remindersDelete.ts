// ============================================================================
// RemindersDelete (P0-6.3 Batch 5 — connectors: native ToolModule rewrite)
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
import { remindersDeleteSchema as schema } from './remindersDelete.schema';
import { captureReminderBefore } from './undoMetadata';

async function executeRemindersDelete(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  if (typeof args.list !== 'string' || args.list.length === 0) {
    return { ok: false, error: 'list must be a non-empty string', code: 'INVALID_ARGS' };
  }
  if (typeof args.reminder_id !== 'string' || args.reminder_id.length === 0) {
    return { ok: false, error: 'reminder_id must be a non-empty string', code: 'INVALID_ARGS' };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  const connector = getConnectorRegistry().get('reminders');
  if (!connector) {
    return { ok: false, error: 'Reminders connector is not available.', code: 'NOT_INITIALIZED' };
  }

  try {
    const undoMetadata = await captureReminderBefore(connector, args);
    const result = await connector.execute('delete_reminder', args);
    const reminder = result.data as {
      id: string;
      list: string;
      title: string;
      deleted: boolean;
    };
    ctx.logger.debug('reminders_delete', { id: reminder.id, list: reminder.list });
    const output = `已删除提醒：\n- #${reminder.id} [${reminder.list}] ${reminder.title}`;

    return {
      ok: true,
      output,
      meta: {
        action: 'delete_reminder',
        connector: 'reminders',
        id: reminder.id,
        list: reminder.list,
        title: reminder.title,
        deleted: reminder.deleted,
        ...undoMetadata,
        artifact: createVirtualArtifact({
          sourceTool: schema.name,
          kind: 'text',
          role: 'receipt',
          sessionId: ctx.sessionId,
          name: `已删除提醒：${reminder.title}`,
          mimeType: 'text/markdown',
          contentLength: output.length,
          preview: output.slice(0, 500),
          metadata: {
            connector: 'reminders',
            action: 'delete_reminder',
            id: reminder.id,
            deleted: reminder.deleted,
            ...undoMetadata,
          },
        }),
      },
    };
  } catch (error) {
    const failure = `Reminders delete failed: ${error instanceof Error ? error.message : String(error)}`;
    return {
      ok: false,
      error: failure,
      meta: {
        action: 'delete_reminder',
        connector: 'reminders',
        list: args.list,
        id: args.reminder_id,
        failureReason: failure,
        artifact: createFailedReceiptArtifact({
          sourceTool: schema.name,
          sessionId: ctx.sessionId,
          action: 'delete_reminder',
          name: `删除提醒失败：${String(args.reminder_id)}`,
          error: failure,
          metadata: { connector: 'reminders', id: args.reminder_id, list: args.list },
        }),
      },
    };
  }
}

class RemindersDeleteHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeRemindersDelete(args, ctx, canUseTool, onProgress);
  }
}

export const remindersDeleteModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new RemindersDeleteHandler();
  },
};
