import type { ToolResult } from '../../../shared/contract';

export function planContextTag(autoApprovePlan: boolean): 'approved-plan' | 'proposed-plan' {
  return autoApprovePlan ? 'approved-plan' : 'proposed-plan';
}

export function shouldEndRunForPlanApproval(
  toolResults: readonly ToolResult[],
  autoApprovePlan: boolean,
): boolean {
  return !autoApprovePlan && toolResults.some((result) => (
    result.success
    && result.metadata?.requiresUserConfirmation === true
    && result.metadata?.confirmationType === 'plan_approval'
  ));
}
