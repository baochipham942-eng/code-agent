// ============================================================================
// Reminders Delete Tool - Delete a local macOS reminder
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { getConnectorRegistry } from '../../connectors';

export const remindersDeleteTool: Tool = {
  name: 'reminders_delete',
  description: `Delete an existing reminder from macOS Reminders.

Required parameters:
- list
- reminder_id

Use this only when the user explicitly wants to remove a real local reminder.`,
  requiresPermission: true,
  permissionLevel: 'write',
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
  tags: ['planning'],
  aliases: ['delete reminder', 'remove reminder'],
  source: 'builtin',
  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const connector = getConnectorRegistry().get('reminders');
    if (!connector) {
      return { success: false, error: 'Reminders connector is not available.' };
    }

    try {
      const result = await connector.execute('delete_reminder', params);
      const reminder = result.data as {
        id: string;
        list: string;
        title: string;
        deleted: boolean;
      };

      return {
        success: true,
        output: `已删除提醒：\n- #${reminder.id} [${reminder.list}] ${reminder.title}`,
        result: reminder,
      };
    } catch (error) {
      return {
        success: false,
        error: `Reminders delete failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
