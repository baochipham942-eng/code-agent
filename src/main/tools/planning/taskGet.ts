// ============================================================================
// Task Get Tool - Get task details by ID (Claude Code 2.x compatible)
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { getTask, listTasks } from './taskStore';

export const taskGetTool: Tool = {
  name: 'task_get',
  description:
    'Get full details of a task by its ID. ' +
    'Use this to understand task requirements, dependencies, and context before starting work.',
  generations: ['gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The ID of the task to retrieve',
      },
    },
    required: ['taskId'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const taskId = params.taskId as string;

    if (!taskId || typeof taskId !== 'string') {
      return {
        success: false,
        error: 'taskId is required and must be a string',
      };
    }

    // Get sessionId from context
    const sessionId = (context as unknown as { sessionId?: string }).sessionId || 'default';

    const task = getTask(sessionId, taskId);

    if (!task) {
      const allTasks = listTasks(sessionId);
      const availableIds = allTasks.map((t) => t.id).join(', ') || 'none';
      return {
        success: false,
        error: `Task #${taskId} not found. Available task IDs: ${availableIds}`,
      };
    }

    // Format blockedBy with open status check
    const allTasks = listTasks(sessionId);
    const openBlockers = task.blockedBy.filter((id) => {
      const blocker = allTasks.find((t) => t.id === id);
      return blocker && blocker.status !== 'completed';
    });

    const blockedByInfo =
      task.blockedBy.length > 0
        ? `  Blocked By: ${task.blockedBy.join(', ')}${
            openBlockers.length > 0 ? ` (${openBlockers.length} open)` : ' (all resolved)'
          }`
        : '';

    const blocksInfo =
      task.blocks.length > 0 ? `  Blocks: ${task.blocks.join(', ')}` : '';

    const metadataInfo =
      Object.keys(task.metadata).length > 0
        ? `  Metadata: ${JSON.stringify(task.metadata)}`
        : '';

    return {
      success: true,
      output:
        `Task #${task.id}:\n` +
        `  Subject: ${task.subject}\n` +
        `  Description: ${task.description}\n` +
        `  Status: ${task.status}\n` +
        `  Priority: ${task.priority}\n` +
        `  Active Form: ${task.activeForm}\n` +
        (task.owner ? `  Owner: ${task.owner}\n` : '') +
        (blockedByInfo ? `${blockedByInfo}\n` : '') +
        (blocksInfo ? `${blocksInfo}\n` : '') +
        (metadataInfo ? `${metadataInfo}\n` : ''),
      metadata: { task },
    };
  },
};
