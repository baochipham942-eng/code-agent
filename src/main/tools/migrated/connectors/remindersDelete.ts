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
  ToolSchema,
} from '../../../protocol/tools';
import { getConnectorRegistry } from '../../../connectors';

const schema: ToolSchema = {
  name: 'reminders_delete',
  description: `Delete an existing reminder from macOS Reminders.

Required parameters:
- list
- reminder_id

Use this only when the user explicitly wants to remove a real local reminder.`,
  inputSchema: {
    type: 'object',
    properties: {
      list: {
        type: 'string',
        description: 'Target reminder list name.',
      },
      reminder_id: {
        type: 'string',
        description: 'Stable reminder id.',
      },
    },
    required: ['list', 'reminder_id'],
  },
  category: 'mcp',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};

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

    return {
      ok: true,
      output: `已删除提醒：\n- #${reminder.id} [${reminder.list}] ${reminder.title}`,
      meta: { id: reminder.id, deleted: reminder.deleted },
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
