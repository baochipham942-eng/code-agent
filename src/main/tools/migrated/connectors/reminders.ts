// ============================================================================
// Reminders (P0-6.3 Batch 5 — connectors: native ToolModule rewrite)
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
  name: 'reminders',
  description: `Read macOS Reminders data via a native connector.

Supported actions:
- get_status
- list_lists
- list_reminders

Use this for local reminders inspection in office workflows.`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get_status', 'list_lists', 'list_reminders'],
        description: 'Reminders action to perform.',
      },
      list: {
        type: 'string',
        description: 'Optional reminder list name for list_reminders.',
      },
      include_completed: {
        type: 'boolean',
        description: 'Whether to include completed reminders.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of reminders to return. Default: 20.',
      },
    },
    required: ['action'],
  },
  category: 'mcp',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};

type RemindersAction = 'get_status' | 'list_lists' | 'list_reminders';

interface ReminderItem {
  id: string | number;
  list: string;
  title: string;
  completed: boolean;
}

function formatReminder(reminder: ReminderItem): string {
  return `- #${reminder.id} [${reminder.list}] ${reminder.title}${reminder.completed ? ' (completed)' : ''}`;
}

async function executeReminders(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const action = args.action;
  if (typeof action !== 'string') {
    return { ok: false, error: 'action must be a string', code: 'INVALID_ARGS' };
  }
  const allowed: RemindersAction[] = ['get_status', 'list_lists', 'list_reminders'];
  if (!allowed.includes(action as RemindersAction)) {
    return { ok: false, error: `Unsupported reminders action: ${action}`, code: 'INVALID_ARGS' };
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
    const result = await connector.execute(action, args);
    ctx.logger.debug('reminders', { action });

    if (action === 'get_status') {
      const status = result.data as { connected: boolean; detail?: string; capabilities: string[] };
      return {
        ok: true,
        output: `Reminders connector: ${status.connected ? 'connected' : 'disconnected'}\n${status.detail || ''}\nCapabilities: ${status.capabilities.join(', ')}`,
        meta: { status },
      };
    }

    if (action === 'list_lists') {
      const lists = result.data as string[];
      return {
        ok: true,
        output: lists.length > 0
          ? `可用提醒列表 (${lists.length})：\n- ${lists.join('\n- ')}`
          : '没有找到可访问的提醒列表。',
        meta: { count: lists.length },
      };
    }

    // list_reminders
    const reminders = result.data as ReminderItem[];
    return {
      ok: true,
      output: reminders.length > 0
        ? `提醒事项 (${reminders.length})：\n${reminders.map(formatReminder).join('\n')}`
        : '没有找到匹配的提醒。',
      meta: { count: reminders.length },
    };
  } catch (error) {
    return {
      ok: false,
      error: `Reminders connector failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

class RemindersHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeReminders(args, ctx, canUseTool, onProgress);
  }
}

export const remindersModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new RemindersHandler();
  },
};
