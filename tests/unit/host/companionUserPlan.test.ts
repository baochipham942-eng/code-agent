import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAN_APPROVAL_CONFIRMATION_TYPE } from '../../../src/shared/contract/planApproval';

const getRecentMessages = vi.hoisted(() => vi.fn((_sessionId: string, _limit: number) => [] as unknown[]));
const getMessages = vi.hoisted(() => vi.fn((_sessionId: string) => [] as unknown[]));

type ResolveApprovalFn = (
  request: unknown,
  deps: { appService: { sendMessage: (envelope: unknown) => Promise<void> } },
) => Promise<{ approval: unknown; tasks: unknown[] }>;
const resolveApproval = vi.hoisted(() => vi.fn<ResolveApprovalFn>(() => Promise.resolve({ approval: null, tasks: [] })));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    isReady: true,
    getRecentMessages: (sessionId: string, limit: number) => getRecentMessages(sessionId, limit),
    getMessages: (sessionId: string) => getMessages(sessionId),
  }),
}));
vi.mock('../../../src/host/services/planning/planApprovalService', () => ({
  resolvePlanApproval: resolveApproval,
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it('refuses deliver when the message is not in the database yet', async () => {
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
    await expect(deliverCompanionUserPlan(id, true, undefined, 'session-a', async () => {
      throw new Error('must not start a run');
    })).resolves.toEqual({ success: false, data: { closed: true } });
  });

  it('forwards hidden plan-turn options so the follow-up is not a visible user message', async () => {
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
    getMessages.mockReturnValueOnce([{
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
    await expect(deliverCompanionUserPlan(id, true, undefined, 'session-a', startRun)).resolves.toEqual({ success: true });
    expect(startRun).toHaveBeenCalledWith('session-a', prompt, { historyVisibility: 'meta', disableAutoAgent: true });
  });

  it('回读走全量消息而非固定窗口：审批卡滑出最近消息后仍可处理（不僵尸）', async () => {
    const id = `stale-window-${Date.now()}`;
    noteCompanionUserPlan('session-a', {
      toolCallId: id,
      success: true,
      metadata: {
        confirmationType: PLAN_APPROVAL_CONFIRMATION_TYPE,
        plan: PLAN,
        planApproval: APPROVAL,
      },
    });
    // 卡片存续期间会话继续，原始 toolCall 早已滑出任何「最近 N 条」窗口。
    getRecentMessages.mockReturnValueOnce([]);
    getMessages.mockReturnValueOnce([
      { id: 'msg-old', toolCalls: [{ id: 'other-call', result: { metadata: {} } }] },
      { id: 'msg-plan', toolCalls: [{ id, result: { metadata: { planApproval: APPROVAL } } }] },
    ]);
    const startRun = vi.fn(async () => {});
    resolveApproval.mockImplementationOnce(async (_request: unknown, deps: { appService: { sendMessage: (envelope: unknown) => Promise<void> } }) => {
      await deps.appService.sendMessage({ content: PLAN, sessionId: 'session-a' });
      return { approval: null, tasks: [] };
    });
    await expect(deliverCompanionUserPlan(id, true, undefined, 'session-a', startRun)).resolves.toEqual({ success: true });
    expect(getMessages).toHaveBeenCalledWith('session-a');
    expect(startRun).toHaveBeenCalled();
  });

  it('DB 读瞬时故障不打断审批路径：转成可控关闭', async () => {
    const id = `db-fault-${Date.now()}`;
    noteCompanionUserPlan('session-a', {
      toolCallId: id,
      success: true,
      metadata: {
        confirmationType: PLAN_APPROVAL_CONFIRMATION_TYPE,
        plan: PLAN,
        planApproval: APPROVAL,
      },
    });
    getMessages.mockImplementationOnce(() => {
      throw new Error('SQLITE_BUSY');
    });
    await expect(deliverCompanionUserPlan(id, true, undefined, 'session-a', async () => {
      throw new Error('must not start a run');
    })).resolves.toEqual({ success: false, data: { closed: true } });
    // 卡片保留：瞬时故障不等于计划被解决。
    expect(listCompanionUserPlans().some(plan => plan.id === id)).toBe(true);
  });

  it('启动失败：卡片保留、带失败原因重新可见、可再批准（同一记录）', async () => {
    const id = `failed-${Date.now()}`;
    noteCompanionUserPlan('session-a', {
      toolCallId: id,
      success: true,
      metadata: {
        confirmationType: PLAN_APPROVAL_CONFIRMATION_TYPE,
        plan: PLAN,
        planApproval: APPROVAL,
      },
    });
    const failed = { ...APPROVAL, status: 'failed', failureReason: 'Session s1 is already running', failedAt: 1234 };
    const startRun = vi.fn(async () => {});
    getMessages.mockReturnValueOnce([{ id: 'msg-1', toolCalls: [{ id, result: { metadata: { planApproval: APPROVAL } } }] }]);
    resolveApproval.mockImplementationOnce(async () => ({ approval: null, tasks: [] }));
    await expect(deliverCompanionUserPlan(id, true, undefined, 'session-a', startRun)).resolves.toEqual({ success: true });
    // 启动失败落定后：DB 记录转 failed（真实链路由 planApprovalService.finalize 写入）。
    getRecentMessages.mockReturnValue([{ id: 'msg-plan', toolCalls: [{ id, result: { metadata: { planApproval: failed } } }] }]);
    const listed = listCompanionUserPlans();
    const card = listed.find(plan => plan.id === id);
    expect(card).toBeDefined();
    expect(card?.failureReason).toBe('Session s1 is already running');
    expect(card?.failedAt).toBe(1234);
    // 重试：failed 仍可决定，走同一条 approval 记录。
    getMessages.mockReturnValueOnce([{ id: 'msg-1', toolCalls: [{ id, result: { metadata: { planApproval: failed } } }] }]);
    resolveApproval.mockImplementationOnce(async (_request: unknown, deps: { appService: { sendMessage: (envelope: unknown) => Promise<void> } }) => {
      await deps.appService.sendMessage({ content: PLAN, sessionId: 'session-a' });
      return { approval: null, tasks: [] };
    });
    await expect(deliverCompanionUserPlan(id, true, undefined, 'session-a', startRun)).resolves.toEqual({ success: true });
    expect(resolveApproval).toHaveBeenCalledTimes(2);
  });

  it('starting 已认领：deliver 直接关闭，不发起第二次决定（不双跑）', async () => {
    const id = `starting-${Date.now()}`;
    noteCompanionUserPlan('session-a', {
      toolCallId: id,
      success: true,
      metadata: {
        confirmationType: PLAN_APPROVAL_CONFIRMATION_TYPE,
        plan: PLAN,
        planApproval: APPROVAL,
      },
    });
    getMessages.mockReturnValueOnce([{
      id: 'msg-1',
      toolCalls: [{ id, result: { metadata: { planApproval: { ...APPROVAL, status: 'starting' } } } }],
    }]);
    await expect(deliverCompanionUserPlan(id, true, undefined, 'session-a', async () => {
      throw new Error('must not start a run');
    })).resolves.toEqual({ success: false, data: { closed: true } });
    expect(resolveApproval).not.toHaveBeenCalled();
    // 卡在 starting 期间仍被投影；重试认领保留失败字段，投影 digest 与失败态一致（不误重发布）。
    getRecentMessages.mockReturnValue([{ id: 'msg-1', toolCalls: [{ id, result: { metadata: { planApproval: { ...APPROVAL, status: 'starting', failureReason: 'Session s1 is already running', failedAt: 1234 } } } }] }]);
    const projected = listCompanionUserPlans().find(plan => plan.id === id);
    expect(projected?.failureReason).toBe('Session s1 is already running');
    expect(projected?.failedAt).toBe(1234);
  });

  it('启动成功：startRun 确认后卡片从 pending 撤下', async () => {
    const id = `succeeded-${Date.now()}`;
    noteCompanionUserPlan('session-a', {
      toolCallId: id,
      success: true,
      metadata: {
        confirmationType: PLAN_APPROVAL_CONFIRMATION_TYPE,
        plan: PLAN,
        planApproval: APPROVAL,
      },
    });
    const startRun = vi.fn(async () => {});
    getMessages.mockReturnValueOnce([{ id: 'msg-1', toolCalls: [{ id, result: { metadata: { planApproval: APPROVAL } } }] }]);
    resolveApproval.mockImplementationOnce(async (_request: unknown, deps: { appService: { sendMessage: (envelope: unknown) => Promise<void> } }) => {
      await deps.appService.sendMessage({ content: PLAN, sessionId: 'session-a' });
      return { approval: null, tasks: [] };
    });
    await expect(deliverCompanionUserPlan(id, true, undefined, 'session-a', startRun)).resolves.toEqual({ success: true });
    expect(listCompanionUserPlans().some(plan => plan.id === id)).toBe(false);
  });

  it('claim 失败：返回可控关闭（手机拿到 approval_conflict 而不是假 resolved）', async () => {
    const id = `claim-fail-${Date.now()}`;
    noteCompanionUserPlan('session-a', {
      toolCallId: id,
      success: true,
      metadata: {
        confirmationType: PLAN_APPROVAL_CONFIRMATION_TYPE,
        plan: PLAN,
        planApproval: APPROVAL,
      },
    });
    getMessages.mockReturnValueOnce([{
      id: 'msg-1',
      toolCalls: [{ id, result: { metadata: { planApproval: APPROVAL } } }],
    }]);
    resolveApproval.mockRejectedValueOnce(new Error('ALREADY_RESOLVED'));
    await expect(deliverCompanionUserPlan(id, true, undefined, 'session-a', async () => {
      throw new Error('must not start a run');
    })).resolves.toEqual({ success: false, data: { closed: true } });
    // 卡片保留原状态，可重试。
    expect(listCompanionUserPlans().some(plan => plan.id === id)).toBe(true);
  });
});
