// Schema-only file (P1 Wave 3 — planning native migration)
import type { ToolSchema } from '../../../protocol/tools';

export const taskGetSchema: ToolSchema = {
  name: 'task_get',
  description:
    'Get full details of a task by its ID. ' +
    'Use this to understand task requirements, dependencies, and context before starting work.',
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
  category: 'planning',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
