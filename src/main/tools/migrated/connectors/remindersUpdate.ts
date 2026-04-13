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
  ToolSchema,
} from '../../../protocol/tools';
import { getConnectorRegistry } from '../../../connectors';

const schema: ToolSchema = {
  name: 'reminders_update',
  description: `Update an existing reminder in macOS Reminders via the native connector.

Required parameters:
- list
- reminder_id

Optional parameters:
- title
- notes
- remind_at_ms
- clear_remind_at
- completed

Use this when the user wants to edit or complete a real local reminder.`,
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
      title: {
        type: 'string',
        description: 'Optional updated reminder title.',
      },
      notes: {
        type: 'string',
        description: 'Optional updated notes. Pass an empty string to clear it.',
      },
      remind_at_ms: {
        type: 'number',
        description: 'Optional updated reminder time in Unix milliseconds.',
      },
      clear_remind_at: {
        type: 'boolean',
        description: 'Set true to clear an existing reminder time.',
      },
      completed: {
        type: 'boolean',
        description: 'Set true to mark complete, false to reopen.',
      },
    },
    required: ['list', 'reminder_id'],
  },
  category: 'mcp',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};

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
