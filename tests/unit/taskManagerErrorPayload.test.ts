// TaskManager 的 task_error 事件必须带**字符串**原因，不是 Error 对象。
//
// G1（2026-07-28 真机）：它此前发的是 `{ error }`（Error 实例），而唯一的消费方
// voiceAgentCoordinator 按 `typeof data?.error === 'string'` 取值——于是每一次失败
// 的 detail 都退化成兜底的「执行失败」四个字，真实原因（「服务认证异常」）全程丢失，
// 用户只可能看到一句废话。
//
// 这条门钉的是**事件载荷的形状**，不是"有没有发事件"。上面那半由
// voiceWorkFailureVisible.test.ts 负责。

import { describe, expect, it, vi } from 'vitest';

const orchestratorMocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('../../src/host/services/infra/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../src/host/platform', () => ({
  app: { getPath: () => '/tmp' },
  AppWindow: { getAllWindows: () => [] },
}));

vi.mock('../../src/host/services', () => ({
  getSessionManager: () => ({
    addMessageToSession: vi.fn(),
    updateMessage: vi.fn(),
    getSession: vi.fn(),
  }),
  notificationService: {
    notifyNeedsInput: vi.fn(),
    notifyTaskComplete: vi.fn(),
  },
}));

vi.mock('../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ isReady: true, updateSession: vi.fn() }),
}));

vi.mock('../../src/host/agent/agentOrchestrator', () => ({
  AgentOrchestrator: class {
    sendMessage = (...args: unknown[]) => orchestratorMocks.sendMessage(...args);
    cancel = () => orchestratorMocks.cancel();
    setSessionId = vi.fn();
    setPlanningService = vi.fn();
    setMessages = vi.fn();
    setWorkingDirectory = vi.fn();
    handlePermissionResponse = vi.fn();
  },
}));

const { TaskManager } = await import('../../src/host/task/TaskManager');

describe('TaskManager task_error 载荷', () => {
  it('带的是字符串原因，不是 Error 对象（否则消费方只能显示兜底文案）', async () => {
    const manager = new TaskManager({ maxConcurrentTasks: 1 });
    manager.initialize({ configService: {} as never, onAgentEvent: vi.fn() });

    orchestratorMocks.sendMessage.mockRejectedValueOnce(new Error('服务认证异常'));

    const events: Array<{ type: string; data?: unknown }> = [];
    manager.on('event', (event) => { events.push(event as { type: string; data?: unknown }); });

    await manager.startTask('session-1', '建个文件');
    // startTask 内部是异步跑的，让微任务队列排空
    await new Promise((resolve) => setTimeout(resolve, 0));

    const errorEvent = events.find((e) => e.type === 'task_error');
    expect(errorEvent, 'task_error 事件必须发出来').toBeDefined();
    const payload = errorEvent!.data as { error?: unknown };
    expect(typeof payload.error).toBe('string');
    expect(payload.error).toBe('服务认证异常');
    expect(payload.error).not.toBeInstanceOf(Error);
  });
});
