// ============================================================================
// Task IPC — TaskManager unavailable fallback
// ============================================================================
//
// web 模式下 webServer 注入 `getTaskManager: () => null`。之前每次 task:* 动作
// 都会抛 "TaskManager not initialized" 并被 logger.error 记录，污染 boot 日志。
// 新逻辑：null 是预期状态，下沉为 debug 日志 + 结构化 unavailable 响应；
// 只读查询（getAllStates / getQueue / getStats）返回安全默认，避免 renderer
// 轮询时触发空指针或额外特判。
// ============================================================================

import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

const logState = vi.hoisted(() => ({
  errorLog: vi.fn(),
  debugLog: vi.fn(),
}));

const platformState = vi.hoisted(() => ({
  rendererListeners: [] as Array<(channel: string, data: unknown) => void>,
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: logState.errorLog,
    debug: logState.debugLog,
  }),
}));

vi.mock('../../../src/main/platform', () => ({
  broadcastToRenderer: (channel: string, data: unknown) => {
    for (const listener of platformState.rendererListeners) {
      listener(channel, data);
    }
  },
  onRendererPush: (listener: (channel: string, data: unknown) => void) => {
    platformState.rendererListeners.push(listener);
    return () => {
      const index = platformState.rendererListeners.indexOf(listener);
      if (index >= 0) platformState.rendererListeners.splice(index, 1);
    };
  },
}));

import { registerTaskHandlers } from '../../../src/main/ipc/task.ipc';
import { onRendererPush } from '../../../src/main/platform';
import { IPC_CHANNELS, IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

type DomainHandler = (_: unknown, request: IPCRequest) => Promise<IPCResponse>;

function makeFakeIpc(): { handle: Mock; getHandler: () => DomainHandler } {
  const registry = new Map<string, DomainHandler>();
  const handle = vi.fn((channel: string, fn: DomainHandler) => {
    registry.set(channel, fn);
  });
  return {
    handle,
    getHandler: () => {
      const fn = registry.get(IPC_DOMAINS.TASK);
      if (!fn) throw new Error('TASK handler not registered');
      return fn;
    },
  };
}

describe('task.ipc — TaskManager unavailable', () => {
  beforeEach(() => {
    logState.errorLog.mockReset();
    logState.debugLog.mockReset();
    platformState.rendererListeners.length = 0;
  });

  it('write 类动作返回结构化 unavailable，不触发 error 日志', async () => {
    const ipc = makeFakeIpc();
    registerTaskHandlers(ipc as never, () => null);
    const handler = ipc.getHandler();

    const actions = ['start', 'interrupt', 'cancel', 'getState', 'cleanup'] as const;
    for (const action of actions) {
      const res = await handler({}, { action, payload: { sessionId: 's1' } });
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe('TASK_MANAGER_UNAVAILABLE');
    }

    expect(logState.errorLog).not.toHaveBeenCalled();
    // 每个 action 走 debug 路径
    expect(logState.debugLog.mock.calls.length).toBe(actions.length);
  });

  it('getAllStates 返回空对象而不是 unavailable，避免 renderer 轮询特判', async () => {
    const ipc = makeFakeIpc();
    registerTaskHandlers(ipc as never, () => null);
    const handler = ipc.getHandler();

    const res = await handler({}, { action: 'getAllStates', payload: {} });
    expect(res.success).toBe(true);
    expect(res.data).toEqual({});
  });

  it('getQueue 返回空数组', async () => {
    const ipc = makeFakeIpc();
    registerTaskHandlers(ipc as never, () => null);
    const handler = ipc.getHandler();

    const res = await handler({}, { action: 'getQueue', payload: {} });
    expect(res.success).toBe(true);
    expect(res.data).toEqual([]);
  });

  it('getStats 返回 0 初值', async () => {
    const ipc = makeFakeIpc();
    registerTaskHandlers(ipc as never, () => null);
    const handler = ipc.getHandler();

    const res = await handler({}, { action: 'getStats', payload: {} });
    expect(res.success).toBe(true);
    expect(res.data).toEqual({ running: 0, queued: 0, available: 0, maxConcurrent: 0 });
  });

  it('TaskManager 可用时照常 dispatch 到下游方法', async () => {
    const fakeManager = Object.assign(new EventEmitter(), {
      getAllStates: vi.fn(() => new Map([['s1', { sessionId: 's1', status: 'idle' }]])),
      getStats: vi.fn(() => ({ running: 1, queued: 2, available: 3, maxConcurrent: 4 })),
      getWaitingQueue: vi.fn(() => ['s2']),
      startTask: vi.fn(async () => {}),
    });
    const ipc = makeFakeIpc();
    registerTaskHandlers(ipc as never, () => fakeManager as never);
    const handler = ipc.getHandler();

    const stats = await handler({}, { action: 'getStats', payload: {} });
    expect(stats.data).toEqual({ running: 1, queued: 2, available: 3, maxConcurrent: 4 });

    const queue = await handler({}, { action: 'getQueue', payload: {} });
    expect(queue.data).toEqual(['s2']);

    const all = await handler({}, { action: 'getAllStates', payload: {} });
    expect(all.data).toEqual({ s1: { sessionId: 's1', status: 'idle' } });
    expect(logState.debugLog).not.toHaveBeenCalled();
  });

  it('TaskManager 可用后把运行状态事件推送到 renderer task:event', async () => {
    const fakeManager = Object.assign(new EventEmitter(), {
      getSessionState: vi.fn(() => ({ status: 'running', startTime: 123 })),
      getAllStates: vi.fn(() => new Map([['s1', { status: 'running', startTime: 123 }]])),
      getStats: vi.fn(() => ({ running: 1, queued: 1, available: 1, maxConcurrent: 3 })),
      getWaitingQueue: vi.fn(() => ['s2']),
    });
    const ipc = makeFakeIpc();
    const pushedEvents: Array<{ channel: string; data: unknown }> = [];
    const unsubscribe = onRendererPush((channel, data) => {
      pushedEvents.push({ channel, data });
    });

    try {
      registerTaskHandlers(ipc as never, () => fakeManager as never);
      const handler = ipc.getHandler();

      await handler({}, { action: 'getStats', payload: {} });
      await handler({}, { action: 'getStats', payload: {} });
      fakeManager.emit('event', {
        type: 'state_change',
        sessionId: 's1',
        data: { status: 'running', startTime: 123 },
      });

      expect(
        pushedEvents.filter(
          (event) =>
            event.channel === IPC_CHANNELS.TASK_EVENT &&
            (event.data as { type?: string }).type === 'state_change'
        )
      ).toEqual([
        {
          channel: IPC_CHANNELS.TASK_EVENT,
          data: {
            type: 'state_change',
            sessionId: 's1',
            data: { status: 'running', startTime: 123 },
          },
        },
      ]);
      expect(pushedEvents).toContainEqual({
        channel: IPC_CHANNELS.TASK_EVENT,
        data: {
          type: 'stats_updated',
          data: { running: 1, queued: 1, available: 1, maxConcurrent: 3 },
        },
      });

      pushedEvents.length = 0;
      fakeManager.emit('event', { type: 'queue_update', sessionId: 's2' });

      expect(pushedEvents).toContainEqual({
        channel: IPC_CHANNELS.TASK_EVENT,
        data: { type: 'queue_update', sessionId: 's2', queue: ['s2'] },
      });
    } finally {
      unsubscribe();
    }
  });
});
