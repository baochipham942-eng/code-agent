// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const taskOutputSchema: ToolSchema = {
  name: 'task_output',
  description: `Retrieves output from a running or completed background task.

Usage:
- Provide task_id to get output from a specific task
- Use block=true (default) to wait for completion, block=false for non-blocking check
- Without task_id, lists all background tasks and their status`,
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
      },
      timeout: {
        type: 'number',
        description: 'Max wait time in milliseconds when blocking (default: 30000)',
      },
    },
    required: [],
  },
  category: 'shell',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
