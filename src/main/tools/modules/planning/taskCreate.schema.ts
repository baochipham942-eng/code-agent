// Schema-only file (P1 Wave 3 — planning native migration)
import type { ToolSchema } from '../../../protocol/tools';

export const taskCreateSchema: ToolSchema = {
  name: 'task_create',
  description:
    'Create a new task to track work progress. ' +
    'Use this for multi-step tasks that need progress tracking. ' +
    'Tasks are session-scoped and support dependencies via task_update.',
  inputSchema: {
    type: 'object',
    properties: {
      subject: {
        type: 'string',
        description: 'Brief task title in imperative form (e.g., "Implement login feature")',
      },
      description: {
        type: 'string',
        description: 'Detailed description of what needs to be done',
      },
      activeForm: {
        type: 'string',
        description:
          'Present continuous form shown while task is in progress ' +
          '(e.g., "Implementing login feature"). Auto-generated if not provided.',
      },
      priority: {
        type: 'string',
        enum: ['low', 'normal', 'high'],
        description: 'Task priority (default: normal)',
      },
      metadata: {
        type: 'object',
        description: 'Arbitrary metadata to attach to the task',
      },
    },
    required: ['subject', 'description'],
  },
  category: 'planning',
  permissionLevel: 'write',
  allowInPlanMode: true,
};
