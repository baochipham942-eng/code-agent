// Schema-only file (P1 Wave 3 — planning native migration)
import type { ToolSchema } from '../../../protocol/tools';

export const planReadSchema: ToolSchema = {
  name: 'plan_read',
  description:
    'Read the current task plan from task_plan.md. ' +
    'Use this to review your progress, objectives, and remaining tasks. ' +
    'Essential for staying on track during complex multi-step tasks.',
  inputSchema: {
    type: 'object',
    properties: {
      includeCompleted: {
        type: 'boolean',
        description: 'Include completed steps in output (default: false)',
        default: false,
      },
      summary: {
        type: 'boolean',
        description: 'Return a brief summary instead of full plan (default: false)',
        default: false,
      },
    },
  },
  category: 'planning',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
