// ============================================================================
// PlanReview (P1 Wave 3 — multiagent: native ToolModule rewrite)
//
// 旧版: src/host/agent/multiagentTools/planReview.ts (legacy Tool)
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - 五链：参数校验 / canUseTool / abort / onProgress / 错误码规范化
// - 错误码：INVALID_ARGS / PERMISSION_DENIED / ABORTED / NOT_FOUND / DOMAIN_ERROR
// - 行为保真：legacy 输出文案 1:1 复刻
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { getPlanApprovalGate } from '../../../agent/planApproval';
import {
  getSwarmRunScopeKey,
  type SwarmAgentRef,
} from '../../../../shared/contract/swarm';
import { planReviewSchema as schema } from './planReview.schema';

export async function executePlanReview(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const planId = args.plan_id;
  const action = args.action;
  const feedback = typeof args.feedback === 'string' ? args.feedback : undefined;

  if (typeof planId !== 'string' || !planId || typeof action !== 'string' || !action) {
    return {
      ok: false,
      error: 'Missing required parameters: plan_id and action',
      code: 'INVALID_ARGS',
    };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  const gate = getPlanApprovalGate();
  const candidate = ctx.swarmRunScope
    ? gate.getPendingPlans(ctx.swarmRunScope).find((plan) => plan.id === planId)
    : gate.getPlan(planId);
  const plan = candidate?.scope && (
    ctx.swarmRunScope
      ? getSwarmRunScopeKey(candidate.scope) === getSwarmRunScopeKey(ctx.swarmRunScope)
      : candidate.scope.sessionId === ctx.sessionId
  )
    ? candidate
    : undefined;

  if (!plan) {
    return {
      ok: false,
      error: `Plan not found: ${planId}. Use plan_review to list pending plans.`,
      code: 'NOT_FOUND',
    };
  }

  if (plan.status !== 'pending') {
    return {
      ok: false,
      error: `Plan ${planId} is already ${plan.status}`,
      code: 'DOMAIN_ERROR',
    };
  }
  const planScope = plan.scope;
  if (!planScope) {
    return {
      ok: false,
      error: `Plan not found: ${planId}. Use plan_review to list pending plans.`,
      code: 'NOT_FOUND',
    };
  }

  // The gate is process-wide, so even a root caller without a run scope must
  // carry its session boundary into the final mutation check. Scoped callers
  // were already matched against the complete session/run/tree key above.
  const expected: SwarmAgentRef = {
    sessionId: planScope.sessionId,
    runId: planScope.runId,
    agentId: plan.agentId,
  };

  if (action === 'approve') {
    const approved = gate.approve(planId, feedback, expected);
    if (!approved) return { ok: false, error: `Plan scope mismatch: ${planId}`, code: 'NOT_FOUND' };
    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('plan_review done', { planId, action });
    return {
      ok: true,
      output: `Plan ${planId} approved for ${plan.agentName}.${feedback ? ` Feedback: ${feedback}` : ''}`,
    };
  }

  if (action === 'reject') {
    if (!feedback) {
      return {
        ok: false,
        error: 'Feedback is required when rejecting a plan',
        code: 'INVALID_ARGS',
      };
    }
    const rejected = gate.reject(planId, feedback, expected);
    if (!rejected) return { ok: false, error: `Plan scope mismatch: ${planId}`, code: 'NOT_FOUND' };
    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('plan_review done', { planId, action });
    return {
      ok: true,
      output: `Plan ${planId} rejected for ${plan.agentName}. Reason: ${feedback}`,
    };
  }

  return {
    ok: false,
    error: `Invalid action: ${action}. Must be "approve" or "reject".`,
    code: 'INVALID_ARGS',
  };
}

class PlanReviewHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executePlanReview(args, ctx, canUseTool, onProgress);
  }
}

export const planReviewModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new PlanReviewHandler();
  },
};
