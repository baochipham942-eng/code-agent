import { describe, expect, it } from 'vitest';
import { PLAN_APPROVAL_CONFIRMATION_TYPE } from '../../../src/shared/contract/planApproval';
import {
  companionPlanRunFromEnvelope,
  deliverCompanionUserPlan,
  listCompanionUserPlans,
  noteCompanionUserPlan,
} from '../../../src/host/services/companion/companionUserPlan';

describe('companionUserPlan registers ChatView exit_plan_mode cards', () => {
  it('notes a pending plan_approval tool result and lists it', () => {
    const id = `plan-${Date.now()}`;
    expect(noteCompanionUserPlan('session-a', {
      toolCallId: id,
      success: true,
      metadata: {
        confirmationType: PLAN_APPROVAL_CONFIRMATION_TYPE,
        plan: '1. 列出标题\n2. 写报告',
        planApproval: { status: 'pending', originalPlan: '1. 列出标题', steps: [] },
      },
    })).toBe(true);
    expect(listCompanionUserPlans().some(plan => plan.id === id && plan.sessionId === 'session-a')).toBe(true);
  });

  it('ignores ordinary tool results', () => {
    expect(noteCompanionUserPlan('session-a', {
      toolCallId: `other-${Date.now()}`,
      success: true,
      metadata: { filePath: '/private/path' },
    })).toBe(false);
  });

  it('does not invent a card when the tool result has no plan text', () => {
    expect(noteCompanionUserPlan('session-a', {
      toolCallId: `empty-${Date.now()}`,
      success: true,
      metadata: { confirmationType: PLAN_APPROVAL_CONFIRMATION_TYPE, plan: '   ' },
    })).toBe(false);
  });

  it('refuses deliver when the message is not in the database yet', () => {
    const id = `missing-${Date.now()}`;
    noteCompanionUserPlan('session-a', {
      toolCallId: id,
      success: true,
      metadata: {
        confirmationType: PLAN_APPROVAL_CONFIRMATION_TYPE,
        plan: 'do the work',
        planApproval: { status: 'pending', originalPlan: 'do the work', steps: [{ id: 'step-1', content: 'do the work', originalContent: 'do the work' }] },
      },
    });
    expect(deliverCompanionUserPlan(id, true, undefined, 'session-a', async () => {
      throw new Error('must not start a run');
    })).toEqual({ success: false, data: { closed: true } });
  });

  it('forwards hidden plan-turn options so the follow-up is not a visible user message', () => {
    expect(companionPlanRunFromEnvelope({
      content: '<approved-plan>do the work</approved-plan>\nExecute this approved plan now.',
      sessionId: 'session-a',
      options: { mode: 'normal', historyVisibility: 'meta', disableAutoAgent: true },
    }, { sessionId: 'fallback', plan: 'fallback' })).toEqual({
      sessionId: 'session-a',
      prompt: '<approved-plan>do the work</approved-plan>\nExecute this approved plan now.',
      historyVisibility: 'meta',
      disableAutoAgent: true,
    });
  });
});
