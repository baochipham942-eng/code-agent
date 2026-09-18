import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, SessionTask } from '../../../src/shared/contract';

const mocks = vi.hoisted(() => ({
  getMessages: vi.fn(),
  updateMessage: vi.fn(),
  replaceTasksAtomically: vi.fn(),
  demoteInProgressTasks: vi.fn(),
  listSessions: vi.fn(),
  getRecentMessages: vi.fn(),
  dbReady: true,
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getMessages: mocks.getMessages,
    updateMessage: mocks.updateMessage,
  }),
}));

vi.mock('../../../src/host/services/planning/taskStore', () => ({
  replaceTasksAtomically: mocks.replaceTasksAtomically,
  demoteInProgressTasks: mocks.demoteInProgressTasks,
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    get isReady() { return mocks.dbReady; },
    listSessions: mocks.listSessions,
    getRecentMessages: mocks.getRecentMessages,
  }),
}));

import {
  reconcileRecentPlanApprovalStarts,
  resolvePlanApproval,
} from '../../../src/host/services/planning/planApprovalService';

function planMessage(
  status: 'pending' | 'starting' | 'approved' | 'failed' | 'cancelled' = 'pending',
  extra: { failureReason?: string; failedAt?: number; feedback?: string; decidedAt?: number } = {},
): Message {
  return {
    id: 'message-plan',
    role: 'assistant',
    content: '',
    timestamp: 1,
    toolCalls: [{
      id: 'tool-plan',
      name: 'exit_plan_mode',
      arguments: { plan: '1. Read code\n2. Implement UI' },
      result: {
        toolCallId: 'tool-plan',
        success: true,
        metadata: {
          confirmationType: 'plan_approval',
          plan: '1. Read code\n2. Implement UI',
          planApproval: {
            status,
            originalPlan: '1. Read code\n2. Implement UI',
            steps: [
              { id: 'step-1', content: 'Read code', originalContent: 'Read code' },
              { id: 'step-2', content: 'Implement UI', originalContent: 'Implement UI' },
            ],
            ...extra,
          },
        },
      },
    }],
  };
}

const tasks: SessionTask[] = [{
  id: '1',
  subject: 'Read host code',
  description: 'Read host code',
  activeForm: 'Read host code',
  status: 'in_progress',
  priority: 'normal',
  blocks: [],
  blockedBy: [],
  metadata: { source: 'plan_approval' },
  createdAt: 1,
  updatedAt: 1,
}];

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const approveRequest = {
  sessionId: 'session-1',
  messageId: 'message-plan',
  toolCallId: 'tool-plan',
  decision: 'approve' as const,
  steps: [
    { id: 'step-1', content: 'Read host code', originalContent: 'Read code', edited: true },
    { id: 'step-2', content: 'Implement UI', originalContent: 'Implement UI' },
  ],
};

describe('resolvePlanApproval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMessages.mockResolvedValue([planMessage()]);
    mocks.updateMessage.mockResolvedValue(undefined);
    mocks.replaceTasksAtomically.mockReturnValue(tasks);
    mocks.demoteInProgressTasks.mockReturnValue(null);
  });

  it('claims starting synchronously, replaces the ledger, and defers approved until start confirmation', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const emitAgentEventForSession = vi.fn();
    // 首读 pending，finalize 重读时记录已被 claim 成 starting（真实链路里落库的就是它）。
    mocks.getMessages
      .mockResolvedValueOnce([planMessage()])
      .mockResolvedValue([planMessage('starting')]);

    const response = await resolvePlanApproval(approveRequest, {
      appService: { sendMessage } as never,
      taskManager: { emitAgentEventForSession } as never,
    });

    expect(mocks.replaceTasksAtomically).toHaveBeenCalledWith(
      'session-1',
      ['Read host code', 'Implement UI'],
    );
    // 同步回执是中间态 starting：approved 必须等启动确认后才落定。
    expect(response.approval.status).toBe('starting');
    expect(response.tasks).toEqual(tasks);
    expect(mocks.updateMessage).toHaveBeenCalledOnce();
    expect(mocks.updateMessage.mock.calls[0][1].toolCalls[0].result.metadata.planApproval.status).toBe('starting');
    expect(emitAgentEventForSession).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ type: 'task_update' }),
    );
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      content: expect.stringContaining('<approved-plan>\n1. Read host code\n2. Implement UI\n</approved-plan>'),
      options: expect.objectContaining({ historyVisibility: 'meta' }),
    }));
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({ disableAutoAgent: true }),
    }));

    await flush();
    // 启动确认后 finalize：approved 落库 + 事件推给客户端卡片。
    expect(mocks.updateMessage).toHaveBeenCalledTimes(2);
    expect(mocks.updateMessage.mock.calls[1][1].toolCalls[0].result.metadata.planApproval.status).toBe('approved');
    const updateEvent = emitAgentEventForSession.mock.calls.find(
      ([, event]) => event.type === 'plan_approval_update',
    );
    expect(updateEvent?.[1].data).toMatchObject({
      sessionId: 'session-1',
      messageId: 'message-plan',
      toolCallId: 'tool-plan',
      approval: { status: 'approved' },
    });
    expect(mocks.demoteInProgressTasks).not.toHaveBeenCalled();
  });

  it('marks the approval failed with the reason when the approved turn fails to start, and demotes the ledger', async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error('Session s1 is already running'));
    const emitAgentEventForSession = vi.fn();
    mocks.getMessages
      .mockResolvedValueOnce([planMessage()])
      .mockResolvedValue([planMessage('starting')]);
    mocks.demoteInProgressTasks.mockReturnValue([{ ...tasks[0], status: 'pending' }]);

    const response = await resolvePlanApproval(approveRequest, {
      appService: { sendMessage } as never,
      taskManager: { emitAgentEventForSession } as never,
    });
    expect(response.approval.status).toBe('starting');

    await flush();
    expect(mocks.updateMessage).toHaveBeenCalledTimes(2);
    const finalized = mocks.updateMessage.mock.calls[1][1].toolCalls[0].result.metadata.planApproval;
    expect(finalized.status).toBe('failed');
    expect(finalized.failureReason).toBe('Session s1 is already running');
    expect(typeof finalized.failedAt).toBe('number');
    const updateEvent = emitAgentEventForSession.mock.calls.find(
      ([, event]) => event.type === 'plan_approval_update',
    );
    expect(updateEvent?.[1].data.approval).toMatchObject({ status: 'failed', failureReason: 'Session s1 is already running' });
    // 台账一致性：启动失败没有在跑的工作，in_progress 退回 pending 并广播。
    expect(mocks.demoteInProgressTasks).toHaveBeenCalledWith('session-1');
    const syncEvents = emitAgentEventForSession.mock.calls.filter(
      ([, event]) => event.type === 'task_update' && event.data.source === 'plan_approval',
    );
    expect(syncEvents).toHaveLength(2);
    expect(syncEvents[1][1].data.tasks[0]).toMatchObject({ status: 'pending' });
  });

  it('clamps an oversized failure reason', async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error('x'.repeat(900)));
    mocks.getMessages
      .mockResolvedValueOnce([planMessage()])
      .mockResolvedValue([planMessage('starting')]);

    await resolvePlanApproval(approveRequest, {
      appService: { sendMessage } as never,
      taskManager: { emitAgentEventForSession: vi.fn() } as never,
    });
    await flush();
    const finalized = mocks.updateMessage.mock.calls[1][1].toolCalls[0].result.metadata.planApproval;
    expect(finalized.failureReason?.length).toBe(501);
    expect(finalized.failureReason?.endsWith('…')).toBe(true);
  });

  it('retries through the same record after a failure: failed is decidable again and the claim keeps the stale failure fields', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    mocks.getMessages
      .mockResolvedValueOnce([planMessage('failed', { failureReason: 'Session s1 is already running', failedAt: 111 })])
      .mockResolvedValue([planMessage('starting')]);

    const response = await resolvePlanApproval(approveRequest, {
      appService: { sendMessage } as never,
      taskManager: { emitAgentEventForSession: vi.fn() } as never,
    });
    expect(response.approval.status).toBe('starting');
    const claimed = mocks.updateMessage.mock.calls[0][1].toolCalls[0].result.metadata.planApproval;
    expect(claimed.status).toBe('starting');
    // 认领不清除失败字段：手机端投影 digest 在「重试启动中」与「失败」之间保持稳定。
    expect(claimed.failureReason).toBe('Session s1 is already running');
    expect(claimed.failedAt).toBe(111);
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('rejects a second decision while the start is claimed (no double run)', async () => {
    mocks.getMessages.mockResolvedValue([planMessage('starting')]);
    await expect(resolvePlanApproval({
      sessionId: 'session-1',
      messageId: 'message-plan',
      toolCallId: 'tool-plan',
      decision: 'approve',
      steps: approveRequest.steps,
    }, {
      appService: { sendMessage: vi.fn() } as never,
      taskManager: { emitAgentEventForSession: vi.fn() } as never,
    })).rejects.toMatchObject({ code: 'ALREADY_RESOLVED' });
  });

  it('finalize never stomps a record that moved on after the claim', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const emitAgentEventForSession = vi.fn();
    mocks.getMessages
      .mockResolvedValueOnce([planMessage()])
      .mockResolvedValue([planMessage('cancelled')]);

    await resolvePlanApproval(approveRequest, {
      appService: { sendMessage } as never,
      taskManager: { emitAgentEventForSession } as never,
    });
    await flush();
    expect(mocks.updateMessage).toHaveBeenCalledOnce();
    expect(emitAgentEventForSession.mock.calls.some(([, event]) => event.type === 'plan_approval_update')).toBe(false);
  });

  it('claims starting for revise and lands revision_requested only after the revision turn starts', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    mocks.getMessages
      .mockResolvedValueOnce([planMessage()])
      .mockResolvedValue([planMessage('starting', { feedback: 'shrink scope' })]);

    const response = await resolvePlanApproval({
      sessionId: 'session-1',
      messageId: 'message-plan',
      toolCallId: 'tool-plan',
      decision: 'revise',
      feedback: 'shrink scope',
    }, {
      appService: { sendMessage } as never,
      taskManager: { emitAgentEventForSession: vi.fn() } as never,
    });
    expect(response.approval.status).toBe('starting');
    expect(response.approval.feedback).toBe('shrink scope');
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('<plan-revision-request>'),
    }));

    await flush();
    const finalized = mocks.updateMessage.mock.calls[1][1].toolCalls[0].result.metadata.planApproval;
    expect(finalized.status).toBe('revision_requested');
    expect(finalized.feedback).toBe('shrink scope');
  });

  it('marks revise failed with a reason when the revision turn cannot start', async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error('No active session'));
    mocks.getMessages
      .mockResolvedValueOnce([planMessage()])
      .mockResolvedValue([planMessage('starting', { feedback: 'shrink scope' })]);

    await resolvePlanApproval({
      sessionId: 'session-1',
      messageId: 'message-plan',
      toolCallId: 'tool-plan',
      decision: 'revise',
      feedback: 'shrink scope',
    }, {
      appService: { sendMessage } as never,
      taskManager: { emitAgentEventForSession: vi.fn() } as never,
    });
    await flush();
    const finalized = mocks.updateMessage.mock.calls[1][1].toolCalls[0].result.metadata.planApproval;
    expect(finalized.status).toBe('failed');
    expect(finalized.failureReason).toBe('No active session');
  });

  it('cancels structurally without replacing tasks or continuing the agent', async () => {
    const sendMessage = vi.fn();
    const response = await resolvePlanApproval({
      sessionId: 'session-1',
      messageId: 'message-plan',
      toolCallId: 'tool-plan',
      decision: 'cancel',
    }, {
      appService: { sendMessage } as never,
      taskManager: { emitAgentEventForSession: vi.fn() } as never,
    });

    expect(response.approval.status).toBe('cancelled');
    expect(mocks.updateMessage).toHaveBeenCalledOnce();
    expect(mocks.replaceTasksAtomically).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('cancel after a failed start resolves the same record (retry can also cancel)', async () => {
    mocks.getMessages.mockResolvedValue([planMessage('failed', { failureReason: 'Session s1 is already running' })]);
    const response = await resolvePlanApproval({
      sessionId: 'session-1',
      messageId: 'message-plan',
      toolCallId: 'tool-plan',
      decision: 'cancel',
    }, {
      appService: { sendMessage: vi.fn() } as never,
      taskManager: { emitAgentEventForSession: vi.fn() } as never,
    });
    expect(response.approval.status).toBe('cancelled');
  });

  it('rejects replay after the approval is already resolved', async () => {
    mocks.getMessages.mockResolvedValue([planMessage('approved')]);
    await expect(resolvePlanApproval({
      sessionId: 'session-1',
      messageId: 'message-plan',
      toolCallId: 'tool-plan',
      decision: 'cancel',
    }, {
      appService: { sendMessage: vi.fn() } as never,
      taskManager: { emitAgentEventForSession: vi.fn() } as never,
    })).rejects.toMatchObject({ code: 'ALREADY_RESOLVED' });
  });

  it('本进程刚认领的 starting 不是孤儿：对账只收早于本进程启动的认领', async () => {
    const freshClaim = planMessage('starting', { decidedAt: Date.now() });
    mocks.listSessions.mockReturnValue([{ id: 'session-1' }]);
    mocks.getRecentMessages.mockReturnValue([freshClaim]);
    mocks.getMessages.mockResolvedValue([freshClaim]);

    const settled = await reconcileRecentPlanApprovalStarts({ taskManager: { emitAgentEventForSession: vi.fn() } as never });

    expect(settled).toBe(0);
    expect(mocks.updateMessage).not.toHaveBeenCalled();
    expect(mocks.demoteInProgressTasks).not.toHaveBeenCalled();
  });
});

describe('starting 崩溃残留对账（宿主轮内退出后的恢复出口）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dbReady = true;
    mocks.updateMessage.mockResolvedValue(undefined);
    mocks.replaceTasksAtomically.mockReturnValue([]);
    mocks.demoteInProgressTasks.mockReturnValue(null);
  });

  it('reconcileRecentPlanApprovalStarts 把残留 starting 落成 failed（可重试）并广播', async () => {
    const emitAgentEventForSession = vi.fn();
    const orphan = planMessage('starting', { decidedAt: Date.now() - 3_600_000 });
    mocks.listSessions.mockReturnValue([{ id: 'session-1' }]);
    mocks.getRecentMessages.mockReturnValue([orphan]);
    // finalize 重读拿到的就是这条记录（仍 starting）→ 落 failed。
    mocks.getMessages.mockResolvedValue([orphan]);
    mocks.demoteInProgressTasks.mockReturnValue([]);

    const settled = await reconcileRecentPlanApprovalStarts({ taskManager: { emitAgentEventForSession } as never });

    expect(settled).toBe(1);
    const finalized = mocks.updateMessage.mock.calls[0][1].toolCalls[0].result.metadata.planApproval;
    expect(finalized.status).toBe('failed');
    expect(finalized.failureReason).toBe('Host exited during plan startup');
    expect(typeof finalized.failedAt).toBe('number');
    expect(emitAgentEventForSession.mock.calls.some(
      ([, event]) => (event as { type?: string }).type === 'plan_approval_update',
    )).toBe(true);
    expect(mocks.demoteInProgressTasks).toHaveBeenCalledWith('session-1');
  });

  it('终态记录不动，非计划工具跳过', async () => {
    const approved = planMessage('approved', { decidedAt: Date.now() - 3_600_000 });
    const plainTool: Message = {
      id: 'message-plain',
      role: 'assistant',
      content: '',
      timestamp: 1,
      toolCalls: [{ id: 'tool-plain', name: 'Read', arguments: {}, result: { toolCallId: 'tool-plain', success: true, metadata: { filePath: '/tmp' } } }],
    };
    mocks.listSessions.mockReturnValue([{ id: 'session-1' }]);
    mocks.getRecentMessages.mockReturnValue([approved, plainTool]);

    const settled = await reconcileRecentPlanApprovalStarts({ taskManager: { emitAgentEventForSession: vi.fn() } as never });

    expect(settled).toBe(0);
    expect(mocks.updateMessage).not.toHaveBeenCalled();
    expect(mocks.demoteInProgressTasks).not.toHaveBeenCalled();
  });

  it('决定路径上的对账：孤儿 starting 先落 failed，本次决定走重试而不是 ALREADY_RESOLVED', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const orphanStarting = planMessage('starting', { decidedAt: Date.now() - 3_600_000 });
    const failed = {
      ...orphanStarting,
      toolCalls: [{
        ...orphanStarting.toolCalls![0],
        result: {
          ...orphanStarting.toolCalls![0].result!,
          metadata: {
            ...orphanStarting.toolCalls![0].result!.metadata!,
            planApproval: {
              ...(orphanStarting.toolCalls![0].result!.metadata!.planApproval as Record<string, unknown>),
              status: 'failed' as const,
              failureReason: 'Host exited during plan startup',
            },
          },
        },
      }],
    };
    mocks.getMessages
      // 1) loadApprovalTarget 首读：孤儿 starting。
      .mockResolvedValueOnce([orphanStarting])
      // 2) finalize 重读：仍 starting → 落 failed。
      .mockResolvedValueOnce([orphanStarting])
      // 3) 对账后重读：failed，可决定。
      .mockResolvedValueOnce([failed])
      // 4) sendMessage settle 后的 finalize 重读：重试认领的 starting → 落 approved。
      .mockResolvedValue([planMessage('starting', { decidedAt: Date.now() })]);

    const response = await resolvePlanApproval(approveRequest, {
      appService: { sendMessage } as never,
      taskManager: { emitAgentEventForSession: vi.fn() } as never,
    });

    // 对账把孤儿收成 failed 后本次决定照常认领（不抛 ALREADY_RESOLVED），sendMessage 真的跑了。
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(response.approval.status).toBe('starting');
    await flush();
    const writes = mocks.updateMessage.mock.calls.map(
      (call) => call[1].toolCalls[0].result.metadata.planApproval.status,
    );
    expect(writes).toEqual(['failed', 'starting', 'approved']);
  });

  it('reconcileRecentPlanApprovalStarts 扫最近会话的近期消息窗口并返回落定数', async () => {
    const orphan = planMessage('starting', { decidedAt: Date.now() - 3_600_000 });
    mocks.listSessions.mockReturnValue([{ id: 'session-crashed' }, { id: 'session-idle' }]);
    mocks.getRecentMessages.mockImplementation((sessionId: string) => (
      sessionId === 'session-crashed' ? [orphan] : []
    ));
    mocks.getMessages.mockResolvedValue([orphan]);
    mocks.demoteInProgressTasks.mockReturnValue([]);

    const settled = await reconcileRecentPlanApprovalStarts({ taskManager: { emitAgentEventForSession: vi.fn() } as never });

    expect(settled).toBe(1);
    expect(mocks.getRecentMessages).toHaveBeenCalledWith('session-crashed', 20);
    expect(mocks.getRecentMessages).toHaveBeenCalledWith('session-idle', 20);
    expect(mocks.updateMessage).toHaveBeenCalledOnce();
    expect(mocks.updateMessage.mock.calls[0][1].toolCalls[0].result.metadata.planApproval.status).toBe('failed');
  });

  it('DB 未就绪时启动对账直接跳过（对账是恢复路径，不拖死启动）', async () => {
    mocks.dbReady = false;
    try {
      const settled = await reconcileRecentPlanApprovalStarts({ taskManager: { emitAgentEventForSession: vi.fn() } as never });
      expect(settled).toBe(0);
      expect(mocks.listSessions).not.toHaveBeenCalled();
    } finally {
      mocks.dbReady = true;
    }
  });
});
