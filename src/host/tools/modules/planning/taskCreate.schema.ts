// Schema-only file (P1 Wave 3 — planning native migration)
import type { ToolSchema } from '../../../protocol/tools';

export const taskCreateSchema: ToolSchema = {
  name: 'task_create',
  description:
    'Create a semantic work-unit task to track progress. ' +
    'Use this for multi-step tasks that need progress tracking. ' +
    'Do not create tasks for low-level tool operations such as reading files, writing files, or running tests. ' +
    'Tasks are session-scoped and support dependencies via task_update.',
  inputSchema: {
    type: 'object',
    properties: {
      subject: {
        type: 'string',
        description:
          'Brief semantic task title visible to the user. Describe the work goal or outcome, not the tool operation ' +
          '(good: "Validate task panel lifecycle"; bad: "Read file", "Write file", or "Run tests").',
      },
      description: {
        type: 'string',
        description: 'Detailed user-visible purpose and completion criteria for this work unit',
      },
      activeForm: {
        type: 'string',
        description:
          'Present continuous semantic form shown while task is in progress ' +
          '(e.g., "Validating task panel lifecycle"). Do not use raw tool actions such as "Reading file". ' +
          'Auto-generated if not provided.',
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
      parentTaskId: {
        type: 'string',
        description: 'Parent task id for hierarchical breakdown (child ids become "1.1", "1.2", ...). Parent must exist.',
      },
      owner: {
        type: 'string',
        description: 'Task owner (agent id). Defaults to the creating subagent when called inside one.',
      },
    },
    required: ['subject', 'description'],
  },
  category: 'planning',
  permissionLevel: 'write',
  allowInPlanMode: true,
};
