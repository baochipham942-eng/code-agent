// ============================================================================
// Reminders Update Tool - Update a local macOS reminder
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { getConnectorRegistry } from '../../connectors';

export const remindersUpdateTool: Tool = {
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
  tags: ['planning'],
  aliases: ['update reminder', 'complete reminder', 'edit reminder'],
  source: 'builtin',
  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const connector = getConnectorRegistry().get('reminders');
    if (!connector) {
      return { success: false, error: 'Reminders connector is not available.' };
    }

    try {
      const result = await connector.execute('update_reminder', params);
      const reminder = result.data as {
        id: string;
        list: string;
        title: string;
        completed: boolean;
      };

      return {
        success: true,
        output: `已更新提醒：\n- #${reminder.id} [${reminder.list}] ${reminder.title}${reminder.completed ? ' (completed)' : ''}`,
        result: reminder,
      };
    } catch (error) {
      return {
        success: false,
        error: `Reminders update failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
