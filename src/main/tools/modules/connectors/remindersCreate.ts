// ============================================================================
// RemindersCreate (P0-6.3 Batch 5 — connectors: native ToolModule rewrite)
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
import { remindersCreateSchema as schema } from './remindersCreate.schema';

async function executeRemindersCreate(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  if (typeof args.list !== 'string' || args.list.length === 0) {
    return { ok: false, error: 'list must be a non-empty string', code: 'INVALID_ARGS' };
  }
  if (typeof args.title !== 'string' || args.title.length === 0) {
    return { ok: false, error: 'title must be a non-empty string', code: 'INVALID_ARGS' };
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
    const result = await connector.execute('create_reminder', args);
    const reminder = result.data as {
      list: string;
      title: string;
      completed: boolean;
    };
    ctx.logger.debug('reminders_create', { list: reminder.list, title: reminder.title });

    return {
      ok: true,
      output: `已创建提醒：\n- [${reminder.list}] ${reminder.title}${reminder.completed ? ' (completed)' : ''}`,
      meta: { list: reminder.list, title: reminder.title },
    };
  } catch (error) {
    return {
      ok: false,
      error: `Reminders create failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

class RemindersCreateHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeRemindersCreate(args, ctx, canUseTool, onProgress);
  }
}

export const remindersCreateModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new RemindersCreateHandler();
  },
};
