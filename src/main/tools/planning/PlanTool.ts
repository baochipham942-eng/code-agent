// ============================================================================
// Plan Tool - Unified plan read/update (Phase 2 consolidation)
// Merges: plan_read, plan_update
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { planReadTool } from './planRead';
import { planUpdateTool } from './planUpdate';

export const PlanTool: Tool = {
  name: 'Plan',
  description: `Unified plan management for reading and updating task plans.

Actions:
- read: Read the current task plan from task_plan.md. Use to review progress, objectives, and remaining tasks.
    Params: includeCompleted (optional bool), summary (optional bool)
- update: Update the status of a step or phase in the task plan.
    Params: stepContent (required), status (required, enum: pending|in_progress|completed|skipped), phaseTitle (optional), addNote (optional)`,

  requiresPermission: false,
  permissionLevel: 'read',

  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['read', 'update'],
        description: 'The plan action to perform',
      },
      // read action
      includeCompleted: {
        type: 'boolean',
        description: '[read] Include completed steps in output (default: false)',
      },
      summary: {
        type: 'boolean',
        description: '[read] Return a brief summary instead of full plan (default: false)',
      },
      // update action
      stepContent: {
        type: 'string',
        description: '[update] Content of the step to update (matches by content)',
      },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed', 'skipped'],
        description: '[update] New status for the step',
      },
      phaseTitle: {
        type: 'string',
        description: '[update] Title of the phase (optional, helps narrow down if steps have similar names)',
      },
      addNote: {
        type: 'string',
        description: '[update] Add a note to the phase (optional)',
      },
    },
    required: ['action'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const action = params.action as string;

    switch (action) {
      case 'read':
        return planReadTool.execute(params, context);

      case 'update':
        return planUpdateTool.execute(params, context);

      default:
        return {
          success: false,
          error: `Unknown action: ${action}. Valid actions: read, update`,
        };
    }
  },
};
