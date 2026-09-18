// 桌面 IPC 路径「启动确认」时点（ai-review Important 后果①）：AgentAppService.sendMessage
// 的 promise 语义是整轮跑完，直接拿它的 settle 当启动确认会让 starting 覆盖整轮运行。
// 这里钉住 respondApproval 交给 resolvePlanApproval 的 appService 已被折算到主 run 的
// task_started：整轮未结束（sendMessage 永不 settle）时 approved 照样落定。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Message } from '../../../src/shared/contract';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

const mocks = vi.hoisted(() => ({
  getMessages: vi.fn(),
  updateMessage: vi.fn(),
  replaceTasksAtomically: vi.fn(),
  demoteInProgressTasks: vi.fn(),
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

// 对账扫描才用 DB；本文件不触达，给个未就绪桩防真库被拉起。
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ isReady: false }),
}));

import { registerPlanningHandlers } from '../../../src/host/ipc/planning.ipc';

function planMessage(
  status: 'pending' | 'starting' | 'approved' | 'failed',
  extra: { failureReason?: string; failedAt?: number; decidedAt?: number } = {},
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

const approveRequest = {
  sessionId: 'session-1',
  messageId: 'message-plan',
  toolCallId: 'tool-plan',
  decision: 'approve' as const,
  steps: [
    { id: 'step-1', content: 'Read code', originalContent: 'Read code' },
    { id: 'step-2', content: 'Implement UI', originalContent: 'Implement UI' },
  ],
};

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;

/** 真实链路形状的 TaskManager：EventEmitter 面 + 审批服务用的事件出口。 */
function makeTaskManager() {
  const tm = new EventEmitter() as EventEmitter & { emitAgentEventForSession: (sessionId: string, event: unknown) => void };
  tm.emitAgentEventForSession = vi.fn();
  return tm;
}

function register(appService: unknown, taskManager: unknown) {
  const handlers = new Map<string, HandlerFn>();
  registerPlanningHandlers(
    { handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never,
    () => null as never,
    () => appService as never,
    () => taskManager as never,
  );
  const handler = handlers.get(IPC_DOMAINS.PLANNING)!;
  return (action: string, payload?: unknown) => handler(null, { action, payload } as IPCRequest);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('respondApproval 桌面 IPC 路径：starting 在启动确认时点落定，不覆盖整轮', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateMessage.mockResolvedValue(undefined);
    mocks.replaceTasksAtomically.mockReturnValue([]);
    mocks.demoteInProgressTasks.mockReturnValue(null);
  });

  it('整轮未结束（sendMessage 永不 settle）时 task_started 即落定 approved', async () => {
    const taskManager = makeTaskManager();
    // 真实链路：sendMessage → tm.startTask → executeTask 同步 emit task_started 后整轮 await。
    const sendMessage = vi.fn(() => {
      taskManager.emit('task_started', { type: 'task_started', sessionId: 'session-1' });
      return new Promise<void>(() => { /* 整轮持续运行中，永不 settle */ });
    });
    mocks.getMessages
      .mockResolvedValueOnce([planMessage('pending')])
      .mockResolvedValue([planMessage('starting')]);
    const call = register({ sendMessage }, taskManager);

    const response = await call('respondApproval', approveRequest);
    expect(response.success).toBe(true);
    expect((response.data as { approval: { status: string } } | undefined)?.approval.status).toBe('starting');
    expect(sendMessage).toHaveBeenCalledOnce();

    // 启动确认（task_started）→ approved 落库 + 事件推给客户端卡片，而整轮仍未结束。
    await vi.waitFor(() => expect(mocks.updateMessage).toHaveBeenCalledTimes(2));
    const finalized = mocks.updateMessage.mock.calls[1][1].toolCalls[0].result.metadata.planApproval;
    expect(finalized.status).toBe('approved');
    expect((taskManager.emitAgentEventForSession as ReturnType<typeof vi.fn>).mock.calls.some(
      ([, event]) => (event as { type?: string }).type === 'plan_approval_update',
    )).toBe(true);
  });

  it('启动前 sendMessage 拒绝（会话占用等）→ 原样上抛落 failed 带原因', async () => {
    const taskManager = makeTaskManager();
    const sendMessage = vi.fn().mockRejectedValue(new Error('Session s1 is already running'));
    mocks.getMessages
      .mockResolvedValueOnce([planMessage('pending')])
      .mockResolvedValue([planMessage('starting')]);
    const call = register({ sendMessage }, taskManager);

    await call('respondApproval', approveRequest);
    await vi.waitFor(() => expect(mocks.updateMessage).toHaveBeenCalledTimes(2));
    const finalized = mocks.updateMessage.mock.calls[1][1].toolCalls[0].result.metadata.planApproval;
    expect(finalized.status).toBe('failed');
    expect(finalized.failureReason).toBe('Session s1 is already running');
    expect(mocks.demoteInProgressTasks).toHaveBeenCalledWith('session-1');
  });

  it('后台 run 的 task_started（带 taskId）与其他会话的 task_started 都不触发落定', async () => {
    const taskManager = makeTaskManager();
    // 后台 run 先响 → 不算主 run 启动；随后另一会话的事件也不算；最后主 run 事件才落定。
    const sendMessage = vi.fn(() => {
      taskManager.emit('task_started', { type: 'task_started', sessionId: 'session-1', data: { taskId: 'bg-1' } });
      return new Promise<void>(() => { /* 整轮持续运行中 */ });
    });
    mocks.getMessages
      .mockResolvedValueOnce([planMessage('pending')])
      .mockResolvedValue([planMessage('starting')]);
    const call = register({ sendMessage }, taskManager);

    await call('respondApproval', approveRequest);
    await settle();
    // 后台 run 不触发：仍只有 claim 那一次写库。
    expect(mocks.updateMessage).toHaveBeenCalledOnce();
    taskManager.emit('task_started', { type: 'task_started', sessionId: 'session-other' });
    await settle();
    expect(mocks.updateMessage).toHaveBeenCalledOnce();
    taskManager.emit('task_started', { type: 'task_started', sessionId: 'session-1' });
    await vi.waitFor(() => expect(mocks.updateMessage).toHaveBeenCalledTimes(2));
    expect(mocks.updateMessage.mock.calls[1][1].toolCalls[0].result.metadata.planApproval.status).toBe('approved');
  });

  it('taskManager 没有 EventEmitter 面（测试桩）→ 退回 sendMessage settle 的旧时点', async () => {
    const emitAgentEventForSession = vi.fn();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    mocks.getMessages
      .mockResolvedValueOnce([planMessage('pending')])
      .mockResolvedValue([planMessage('starting')]);
    const call = register({ sendMessage }, { emitAgentEventForSession });

    await call('respondApproval', approveRequest);
    await vi.waitFor(() => expect(mocks.updateMessage).toHaveBeenCalledTimes(2));
    expect(mocks.updateMessage.mock.calls[1][1].toolCalls[0].result.metadata.planApproval.status).toBe('approved');
  });
});
