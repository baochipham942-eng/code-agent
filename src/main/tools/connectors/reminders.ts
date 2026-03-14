// ============================================================================
// Reminders Tool - Native macOS Reminders connector
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { getConnectorRegistry } from '../../connectors';

function formatReminder(reminder: any): string {
  return `- #${reminder.id} [${reminder.list}] ${reminder.title}${reminder.completed ? ' (completed)' : ''}`;
}

export const remindersTool: Tool = {
  name: 'reminders',
  description: `Read macOS Reminders data via a native connector.

Supported actions:
- get_status
- list_lists
- list_reminders

Use this for local reminders inspection in office workflows.`,
  requiresPermission: true,
  permissionLevel: 'read',
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
  tags: ['planning'],
  aliases: ['reminder list', 'todo reminders', 'tasks'],
  source: 'builtin',
  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const action = params.action as string;
    const connector = getConnectorRegistry().get('reminders');
    if (!connector) {
      return { success: false, error: 'Reminders connector is not available.' };
    }

    try {
      const result = await connector.execute(action, params);

      if (action === 'get_status') {
        const status = result.data as { connected: boolean; detail?: string; capabilities: string[] };
        return {
          success: true,
          output: `Reminders connector: ${status.connected ? 'connected' : 'disconnected'}\n${status.detail || ''}\nCapabilities: ${status.capabilities.join(', ')}`,
          result: status,
        };
      }

      if (action === 'list_lists') {
        const lists = result.data as string[];
        return {
          success: true,
          output: lists.length > 0
            ? `可用提醒列表 (${lists.length})：\n- ${lists.join('\n- ')}`
            : '没有找到可访问的提醒列表。',
          result: lists,
        };
      }

      if (action === 'list_reminders') {
        const reminders = result.data as any[];
        return {
          success: true,
          output: reminders.length > 0
            ? `提醒事项 (${reminders.length})：\n${reminders.map(formatReminder).join('\n')}`
            : '没有找到匹配的提醒。',
          result: reminders,
          metadata: { count: reminders.length },
        };
      }

      return { success: false, error: `Unsupported reminders action: ${action}` };
    } catch (error) {
      return {
        success: false,
        error: `Reminders connector failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
