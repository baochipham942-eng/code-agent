import { describe, expect, it, vi } from 'vitest';
import { PLAN_APPROVAL_CONFIRMATION_TYPE } from '../../../src/shared/contract/planApproval';

const getRecentMessages = vi.hoisted(() => vi.fn((_sessionId: string, _limit: number) => [] as unknown[]));
const resolveApproval = vi.hoisted(() => vi.fn(() => Promise.resolve({ approval: null, tasks: [] })));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    isReady: true,
    getRecentMessages: (sessionId: string, limit: number) => getRecentMessages(sessionId, limit),
  }),
}));
vi.mock('../../../src/host/services/planning/planApprovalService', () => ({
  resolvePlanApproval: (...args: unknown[]) => resolveApproval(...args),
}));
vi.mock('../../../src/host/task/TaskManager', () => ({
  getTaskManager: () => ({ emitAgentEventForSession: () => {} }),
}));

import {
  deliverCompanionUserPlan,
  listCompanionUserPlans,
  noteCompanionUserPlan,
} from '../../../src/host/services/companion/companionUserPlan';

const PLAN = 'do the work';
const STEPS = [{ id: 'step-1', content: PLAN, originalContent: PLAN }];
const APPROVAL = { status: 'pending', originalPlan: PLAN, steps: STEPS };

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
        plan: PLAN,
        planApproval: APPROVAL,
      },
    });
    expect(deliverCompanionUserPlan(id, true, undefined, 'session-a', async () => {
      throw new Error('must not start a run');
    })).toEqual({ success: false, data: { closed: true } });
  });

  it('forwards hidden plan-turn options so the follow-up is not a visible user message', () => {
    const id = `deliver-${Date.now()}`;
    noteCompanionUserPlan('session-a', {
      toolCallId: id,
      success: true,
      metadata: {
        confirmationType: PLAN_APPROVAL_CONFIRMATION_TYPE,
        plan: PLAN,
        planApproval: APPROVAL,
      },
    });
    getRecentMessages.mockReturnValueOnce([{
      id: 'msg-1',
      toolCalls: [{ id, result: { metadata: { planApproval: APPROVAL } } }],
    }]);
    const startRun = vi.fn(async () => {});
    const prompt = '<approved-plan>do the work</approved-plan>\nExecute this approved plan now.';
    resolveApproval.mockImplementationOnce(async (_request: unknown, deps: { appService: { sendMessage: (envelope: unknown) => Promise<void> } }) => {
      await deps.appService.sendMessage({
        content: prompt,
        sessionId: 'session-a',
        options: { mode: 'normal', historyVisibility: 'meta', disableAutoAgent: true },
      });
      return { approval: null, tasks: [] };
    });
    expect(deliverCompanionUserPlan(id, true, undefined, 'session-a', startRun)).toEqual({ success: true });
    expect(startRun).toHaveBeenCalledWith('session-a', prompt, { historyVisibility: 'meta', disableAutoAgent: true });
  });
});
