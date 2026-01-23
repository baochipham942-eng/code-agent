// ============================================================================
// TaskOutput Tool - Get output from background tasks
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import {
  getTaskOutput,
  getAllBackgroundTasks,
  isTaskId,
  getBackgroundTask,
} from './backgroundTasks';

export const taskOutputTool: Tool = {
  name: 'task_output',
  description: `Retrieves output from a running or completed background task.

Usage:
- Provide task_id to get output from a specific task
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- Default timeout for blocking is 30 seconds

Without task_id:
- Returns a list of all background tasks and their status

Task types supported:
- Background shell commands (started with run_in_background=true)
- Background agent tasks

Output includes:
- Current status (running/completed/failed)
- Task output (stdout and stderr)
- Exit code (for completed tasks)
- Duration`,

  generations: ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',

  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'The task ID to get output from. If not provided, lists all tasks.',
      },
      block: {
        type: 'boolean',
        description: 'Whether to wait for task completion (default: true)',
        default: true,
      },
      timeout: {
        type: 'number',
        description: 'Max wait time in milliseconds when blocking (default: 30000)',
        default: 30000,
      },
    },
    required: [],
  },

  async execute(
    params: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolExecutionResult> {
    const taskId = params.task_id as string | undefined;
    const block = params.block !== false; // default true
    const timeout = (params.timeout as number) || 30000;

    // If no task_id, list all tasks
    if (!taskId) {
      const tasks = getAllBackgroundTasks();

      if (tasks.length === 0) {
        return {
          success: true,
          output: 'No background tasks found.',
        };
      }

      const lines = [`Found ${tasks.length} background task(s):\n`];

      for (const task of tasks) {
        const durationSec = (task.duration / 1000).toFixed(1);
        const statusIcon =
          task.status === 'running' ? '🔄' : task.status === 'completed' ? '✅' : '❌';

        lines.push(`${statusIcon} Task: ${task.taskId}`);
        lines.push(`   Command: ${task.command.substring(0, 60)}${task.command.length > 60 ? '...' : ''}`);
        lines.push(`   Status: ${task.status}`);
        lines.push(`   Duration: ${durationSec}s`);
        if (task.exitCode !== undefined) {
          lines.push(`   Exit code: ${task.exitCode}`);
        }
        lines.push(`   Output file: ${task.outputFile}`);
        lines.push('');
      }

      return {
        success: true,
        output: lines.join('\n'),
      };
    }

    // Check if task exists
    if (!isTaskId(taskId)) {
      const tasks = getAllBackgroundTasks();
      if (tasks.length === 0) {
        return {
          success: false,
          error: `Task ${taskId} not found. There are no background tasks.`,
        };
      }

      const taskList = tasks
        .map((t) => `  - ${t.taskId} (${t.status})`)
        .join('\n');

      return {
        success: false,
        error: `Task ${taskId} not found.\n\nAvailable tasks:\n${taskList}`,
      };
    }

    // Get task output
    const result = await getTaskOutput(taskId, block, timeout);

    if (!result) {
      return {
        success: false,
        error: `Failed to get output for task: ${taskId}`,
      };
    }

    const task = getBackgroundTask(taskId);
    const durationSec = (result.duration / 1000).toFixed(2);

    const lines: string[] = [];
    lines.push(`=== Task ${taskId} ===`);
    lines.push(`Status: ${result.status}`);
    lines.push(`Duration: ${durationSec}s`);

    if (result.exitCode !== undefined) {
      lines.push(`Exit code: ${result.exitCode}`);
    }

    if (task) {
      lines.push(`Command: ${task.command}`);
      lines.push(`Output file: ${task.outputFile}`);
    }

    lines.push('');
    lines.push('--- Output ---');
    lines.push(result.output || '(no output)');

    return {
      success: true,
      output: lines.join('\n'),
      metadata: {
        taskId,
        status: result.status,
        exitCode: result.exitCode,
        duration: result.duration,
      },
    };
  },
};
