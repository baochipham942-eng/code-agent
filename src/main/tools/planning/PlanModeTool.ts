// ============================================================================
// PlanMode Tool - Unified plan mode enter/exit (Phase 2 consolidation)
// Merges: enter_plan_mode, exit_plan_mode
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { enterPlanModeTool } from './enterPlanMode';
import { exitPlanModeTool } from './exitPlanMode';

export const PlanModeTool: Tool = {
  name: 'PlanMode',
  description: `Enter or exit plan mode for complex implementation tasks.

Actions:
- enter: Enter plan mode for exploration and design before implementing complex features.
    Params: reason (optional, why you are entering plan mode)
- exit: Exit plan mode and present the implementation plan for user approval.
    Params: plan (required, the implementation plan in Markdown format)

When to use plan mode:
- New feature implementation (not simple modifications)
- Multiple valid approaches need evaluation
- Architectural decisions required
- Multi-file changes (>3 files)
- Requirements are ambiguous and need exploration

When to skip:
- Single-line or small fixes (typos, simple bugs)
- Clear-cut single-function additions
- User gave detailed specific instructions`,

  requiresPermission: false,
  permissionLevel: 'read',

  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['enter', 'exit'],
        description: 'Enter or exit plan mode',
      },
      // enter action
      reason: {
        type: 'string',
        description: '[enter] Reason for entering plan mode (optional)',
      },
      // exit action
      plan: {
        type: 'string',
        description: '[exit] Implementation plan in Markdown format (required for exit)',
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
      case 'enter':
        return enterPlanModeTool.execute(params, context);

      case 'exit':
        return exitPlanModeTool.execute(params, context);

      default:
        return {
          success: false,
          error: `Unknown action: ${action}. Valid actions: enter, exit`,
        };
    }
  },
};
