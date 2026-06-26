// Schema-only file (P1 Wave 3 — planning native migration)
import type { ToolSchema } from '../../../protocol/tools';

export const planUpdateSchema: ToolSchema = {
  name: 'plan_update',
  description:
    'Update the status of a step or phase in the task plan. ' +
    'Use this after completing a task step or when a step is blocked.',
  inputSchema: {
    type: 'object',
    properties: {
      stepContent: {
        type: 'string',
        description: 'Content of the step to update (matches by content)',
      },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed', 'skipped'],
        description: 'New status for the step',
      },
      phaseTitle: {
        type: 'string',
        description: 'Title of the phase (optional, helps narrow down if steps have similar names)',
      },
      addNote: {
        type: 'string',
        description: 'Add a note to the phase (optional)',
      },
    },
    required: ['stepContent', 'status'],
  },
  category: 'planning',
  permissionLevel: 'write',
  allowInPlanMode: true,
};
