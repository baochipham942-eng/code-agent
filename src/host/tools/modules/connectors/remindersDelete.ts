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
import { createVirtualArtifact } from '../../artifacts/artifactMeta';
import { remindersDeleteSchema as schema } from './remindersDelete.schema';

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
        artifact: createVirtualArtifact({
          sourceTool: schema.name,
          kind: 'text',
          sessionId: ctx.sessionId,
          name: `reminder-delete-${reminder.id}`,
          mimeType: 'text/markdown',
          contentLength: output.length,
          preview: output.slice(0, 500),
          metadata: {
            connector: 'reminders',
            action: 'delete_reminder',
            id: reminder.id,
            deleted: reminder.deleted,
          },
        }),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: `Reminders delete failed: ${error instanceof Error ? error.message : String(error)}`,
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
