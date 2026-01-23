// ============================================================================
// KillShell Tool - Terminates background shell processes
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { killBackgroundTask, isTaskId, getAllBackgroundTasks } from './backgroundTasks';

export const killShellTool: Tool = {
  name: 'kill_shell',
  description: `Kills a running background bash shell by its ID.

Usage:
- Takes a task_id parameter identifying the shell to kill
- Returns success or failure status
- Use this when you need to terminate a long-running background command

To find available task IDs:
- Check the task_id returned when you started a background command
- Or list running tasks using the task_output tool without parameters`,

  generations: ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'execute',

  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'The ID of the background shell/task to kill',
      },
    },
    required: ['task_id'],
  },

  async execute(
    params: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolExecutionResult> {
    const taskId = params.task_id as string;

    if (!taskId) {
      return {
        success: false,
        error: 'task_id is required',
      };
    }

    // Check if task exists
    if (!isTaskId(taskId)) {
      // List available tasks
      const tasks = getAllBackgroundTasks();
      const runningTasks = tasks.filter((t) => t.status === 'running');

      if (runningTasks.length === 0) {
        return {
          success: false,
          error: `No task found with ID: ${taskId}. There are no running background tasks.`,
        };
      }

      const taskList = runningTasks
        .map(
          (t) =>
            `  - ${t.taskId}: ${t.command.substring(0, 50)}${t.command.length > 50 ? '...' : ''}`
        )
        .join('\n');

      return {
        success: false,
        error: `No task found with ID: ${taskId}.\n\nRunning tasks:\n${taskList}`,
      };
    }

    const result = killBackgroundTask(taskId);

    if (result.success) {
      return {
        success: true,
        output: result.message || `Successfully killed task: ${taskId}`,
      };
    } else {
      return {
        success: false,
        error: result.error || 'Failed to kill task',
      };
    }
  },
};
