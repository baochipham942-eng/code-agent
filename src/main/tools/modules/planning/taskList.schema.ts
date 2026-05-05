// Schema-only file (P1 Wave 3 — planning native migration)
import type { ToolSchema } from '../../../protocol/tools';

export const taskListSchema: ToolSchema = {
  name: 'task_list',
  description:
    'List all tasks in the current session. ' +
    'Returns a summary of each task including ID, subject, status, owner, and dependencies. ' +
    'Use task_get for full task details.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  category: 'planning',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
