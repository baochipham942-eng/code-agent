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

    return {
      ok: true,
      output: `已更新提醒：\n- #${reminder.id} [${reminder.list}] ${reminder.title}${reminder.completed ? ' (completed)' : ''}`,
      meta: { id: reminder.id, completed: reminder.completed },
    };
  } catch (error) {
    return {
      ok: false,
      error: `Reminders update failed: ${error instanceof Error ? error.message : String(error)}`,
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
