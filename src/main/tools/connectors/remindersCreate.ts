// ============================================================================
// Reminders Create Tool - Write access to local macOS Reminders
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { getConnectorRegistry } from '../../connectors';

export const remindersCreateTool: Tool = {
  name: 'reminders_create',
  description: `Create a new reminder in macOS Reminders via the native connector.

Required parameters:
- list
- title

Optional parameters:
- notes
- remind_at_ms

Use this only when the user wants to create a real local reminder.`,
  requiresPermission: true,
  permissionLevel: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      list: {
        type: 'string',
        description: 'Target reminder list name.',
      },
      title: {
        type: 'string',
        description: 'Reminder title.',
      },
      notes: {
        type: 'string',
        description: 'Optional reminder notes/body.',
      },
      remind_at_ms: {
        type: 'number',
        description: 'Optional reminder time in Unix milliseconds.',
      },
    },
    required: ['list', 'title'],
  },
  tags: ['planning'],
  aliases: ['create reminder', 'new reminder'],
  source: 'builtin',
  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const connector = getConnectorRegistry().get('reminders');
    if (!connector) {
      return { success: false, error: 'Reminders connector is not available.' };
    }

    try {
      const result = await connector.execute('create_reminder', params);
      const reminder = result.data as {
        list: string;
        title: string;
        completed: boolean;
      };

      return {
        success: true,
        output: `已创建提醒：\n- [${reminder.list}] ${reminder.title}${reminder.completed ? ' (completed)' : ''}`,
        result: reminder,
      };
    } catch (error) {
      return {
        success: false,
        error: `Reminders create failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
