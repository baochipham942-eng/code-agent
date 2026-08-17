import { describe, expect, it } from 'vitest';
import type { ToolResult } from '../../../src/shared/contract';
import {
  planContextTag,
  shouldEndRunForPlanApproval,
} from '../../../src/host/agent/runtime/planApprovalRunBoundary';

const pendingPlanResult: ToolResult = {
  toolCallId: 'tool-plan',
  success: true,
  metadata: {
    requiresUserConfirmation: true,
    confirmationType: 'plan_approval',
  },
};

describe('plan approval run boundary', () => {
  it('ends the desktop run before any unapproved execution can continue', () => {
    expect(shouldEndRunForPlanApproval([pendingPlanResult], false)).toBe(true);
    expect(planContextTag(false)).toBe('proposed-plan');
  });

  it('keeps CLI autoApprovePlan continuation semantics', () => {
    expect(shouldEndRunForPlanApproval([pendingPlanResult], true)).toBe(false);
    expect(planContextTag(true)).toBe('approved-plan');
  });

  it('does not stop for unrelated confirmations', () => {
    expect(shouldEndRunForPlanApproval([{
      ...pendingPlanResult,
      metadata: { requiresUserConfirmation: true, confirmationType: 'permission' },
    }], false)).toBe(false);
  });
});
