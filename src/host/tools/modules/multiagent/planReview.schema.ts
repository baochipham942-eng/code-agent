// Schema-only file (P1 Wave 3 — multiagent native migration)
import type { ToolSchema } from '../../../protocol/tools';

export const planReviewSchema: ToolSchema = {
  name: 'plan_review',
  description: `Review and approve/reject a plan submitted by a sub-agent.

Use this tool when a sub-agent submits a plan for approval before executing high-risk operations.
You can approve the plan to let the agent proceed, or reject it with feedback.

Parameters:
- plan_id: The ID of the plan to review (from the plan submission notification)
- action: "approve" or "reject"
- feedback: Optional feedback message (required when rejecting)`,
  inputSchema: {
    type: 'object',
    properties: {
      plan_id: {
        type: 'string',
        description: 'The plan ID to review',
      },
      action: {
        type: 'string',
        enum: ['approve', 'reject'],
        description: 'Whether to approve or reject the plan',
      },
      feedback: {
        type: 'string',
        description: 'Optional feedback (required for rejection)',
      },
    },
    required: ['plan_id', 'action'],
  },
  category: 'multiagent',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
