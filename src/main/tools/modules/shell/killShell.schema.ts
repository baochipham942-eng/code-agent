// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const killShellSchema: ToolSchema = {
  name: 'kill_shell',
  description: `Kills a running background bash shell by its ID.

Usage:
- Takes a task_id parameter identifying the shell to kill
- Returns success or failure status

To find available task IDs: check the task_id returned when starting a background command, or list running tasks via task_output.`,
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
  category: 'shell',
  permissionLevel: 'execute',
  readOnly: false,
  allowInPlanMode: false,
};
