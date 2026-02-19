// ============================================================================
// Plan Review Tool - Coordinator 用来审批/拒绝子 Agent 的 plan
// ============================================================================

import type { Tool, ToolExecutionResult } from '../toolRegistry';
import { getPlanApprovalGate } from '../../agent/planApproval';

export const planReviewTool: Tool = {
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
  generations: ['gen7'],
  requiresPermission: false,
  permissionLevel: 'read' as const,

  async execute(
    params: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    const planId = params.plan_id as string;
    const action = params.action as string;
    const feedback = params.feedback as string | undefined;

    if (!planId || !action) {
      return {
        success: false,
        error: 'Missing required parameters: plan_id and action',
      };
    }

    const gate = getPlanApprovalGate();
    const plan = gate.getPlan(planId);

    if (!plan) {
      return {
        success: false,
        error: `Plan not found: ${planId}. Use plan_review to list pending plans.`,
      };
    }

    if (plan.status !== 'pending') {
      return {
        success: false,
        error: `Plan ${planId} is already ${plan.status}`,
      };
    }

    if (action === 'approve') {
      gate.approve(planId, feedback);
      return {
        success: true,
        output: `Plan ${planId} approved for ${plan.agentName}.${feedback ? ` Feedback: ${feedback}` : ''}`,
      };
    }

    if (action === 'reject') {
      if (!feedback) {
        return {
          success: false,
          error: 'Feedback is required when rejecting a plan',
        };
      }
      gate.reject(planId, feedback);
      return {
        success: true,
        output: `Plan ${planId} rejected for ${plan.agentName}. Reason: ${feedback}`,
      };
    }

    return {
      success: false,
      error: `Invalid action: ${action}. Must be "approve" or "reject".`,
    };
  },
};

// Also export as PascalCase alias
export const PlanReviewTool = planReviewTool;
