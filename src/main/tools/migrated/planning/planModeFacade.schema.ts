// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const PLAN_MODE_ACTIONS = ['enter', 'exit'] as const;

export const planModeFacadeSchema: ToolSchema = {
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
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...PLAN_MODE_ACTIONS],
        description: 'Enter or exit plan mode',
      },
      reason: {
        type: 'string',
        description: '[enter] Reason for entering plan mode (optional)',
      },
      plan: {
        type: 'string',
        description: '[exit] Implementation plan in Markdown format (required for exit)',
      },
    },
    required: ['action'],
  },
  category: 'planning',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: true,
};
