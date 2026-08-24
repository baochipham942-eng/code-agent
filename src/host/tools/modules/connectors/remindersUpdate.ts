// ============================================================================
// RemindersUpdate (P0-6.3 Batch 5 — connectors: native ToolModule rewrite)
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
import { remindersUpdateSchema as schema } from './remindersUpdate.schema';

async function executeRemindersUpdate(
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
    const result = await connector.execute('update_reminder', args);
    const reminder = result.data as {
      id: string;
      list: string;
      title: string;
      completed: boolean;
    };
    ctx.logger.debug('reminders_update', { id: reminder.id, list: reminder.list });
    const output = `已更新提醒：\n- #${reminder.id} [${reminder.list}] ${reminder.title}${reminder.completed ? ' (completed)' : ''}`;

    return {
      ok: true,
      output,
      meta: {
        action: 'update_reminder',
        connector: 'reminders',
        id: reminder.id,
        list: reminder.list,
        title: reminder.title,
        completed: reminder.completed,
        artifact: createVirtualArtifact({
          sourceTool: schema.name,
          kind: 'text',
          role: 'receipt',
          sessionId: ctx.sessionId,
          name: `已更新提醒：${reminder.title}`,
          mimeType: 'text/markdown',
          contentLength: output.length,
          preview: output.slice(0, 500),
          metadata: {
            connector: 'reminders',
            action: 'update_reminder',
            id: reminder.id,
            completed: reminder.completed,
          },
        }),
      },
    };
  } catch (error) {
    const failure = `Reminders update failed: ${error instanceof Error ? error.message : String(error)}`;
    return {
      ok: false,
      error: failure,
      meta: {
        action: 'update_reminder',
        connector: 'reminders',
        list: args.list,
        id: args.reminder_id,
        title: args.title,
        failureReason: failure,
        artifact: createFailedReceiptArtifact({
          sourceTool: schema.name,
          sessionId: ctx.sessionId,
          action: 'update_reminder',
          name: `更新提醒失败：${String(args.title ?? args.reminder_id)}`,
          error: failure,
          metadata: { connector: 'reminders', id: args.reminder_id, title: args.title },
        }),
      },
    };
  }
}

class RemindersUpdateHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeRemindersUpdate(args, ctx, canUseTool, onProgress);
  }
}

export const remindersUpdateModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new RemindersUpdateHandler();
  },
};
