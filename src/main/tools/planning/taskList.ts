// ============================================================================
// Task List Tool - List all session tasks (Claude Code 2.x compatible)
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { listTasks } from './taskStore';

export const taskListTool: Tool = {
  name: 'task_list',
  description:
    'List all tasks in the current session. ' +
    'Returns a summary of each task including ID, subject, status, owner, and dependencies. ' +
    'Use task_get for full task details.',
  generations: ['gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {},
  },

  async execute(
    _params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    // Get sessionId from context
    const sessionId = (context as unknown as { sessionId?: string }).sessionId || 'default';

    const tasks = listTasks(sessionId);

    if (tasks.length === 0) {
      return {
        success: true,
        output: 'No tasks in this session. Use task_create to create new tasks.',
      };
    }

    // Build summary for each task
    const taskSummaries = tasks.map((task) => {
      const statusIcon =
        task.status === 'completed' ? '●' : task.status === 'in_progress' ? '◐' : '○';

      // Check for open blockers
      const openBlockers = task.blockedBy.filter((id) => {
        const blocker = tasks.find((t) => t.id === id);
        return blocker && blocker.status !== 'completed';
      });

      const blockedInfo =
        openBlockers.length > 0 ? ` [blocked by: ${openBlockers.join(', ')}]` : '';

      const ownerInfo = task.owner ? ` (@${task.owner})` : '';

      return `${statusIcon} #${task.id}: ${task.subject}${ownerInfo}${blockedInfo}`;
    });

    // Statistics
    const completed = tasks.filter((t) => t.status === 'completed').length;
    const inProgress = tasks.filter((t) => t.status === 'in_progress').length;
    const pending = tasks.filter((t) => t.status === 'pending').length;
    const blocked = tasks.filter((t) => {
      const openBlockers = t.blockedBy.filter((id) => {
        const blocker = tasks.find((bt) => bt.id === id);
        return blocker && blocker.status !== 'completed';
      });
      return openBlockers.length > 0 && t.status !== 'completed';
    }).length;

    return {
      success: true,
      output:
        `Tasks (${completed}/${tasks.length} completed):\n` +
        taskSummaries.join('\n') +
        '\n\n' +
        `Status: ${completed} completed, ${inProgress} in progress, ${pending} pending` +
        (blocked > 0 ? `, ${blocked} blocked` : ''),
      metadata: {
        tasks: tasks.map((t) => ({
          id: t.id,
          subject: t.subject,
          status: t.status,
          owner: t.owner,
          blockedBy: t.blockedBy,
        })),
        stats: { total: tasks.length, completed, inProgress, pending, blocked },
      },
    };
  },
};
