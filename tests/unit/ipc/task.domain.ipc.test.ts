import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// task.ipc.ts 派发特征测试（RQ-183 续作·TASK 刀迁表前钉住现状）：既有 taskIpc.unavailable.test.ts 覆盖
// TaskManager 缺席兜底与三个只读 action / cancelBackgroundTask / 事件桥；这里补齐 manager 可用时
// start / interrupt / cancel / getState / cleanup 的委派与 null 返回、未知 action 在两种状态下的契约
// （可用 → INVALID_ACTION 'Unknown action:'；缺席 → TASK_MANAGER_UNAVAILABLE + debug 一次）、抛错兜底
// （INTERNAL_ERROR，Error → message、非 Error → String(error)，记 `Task IPC error [<action>]:` 日志），
// 以及事件桥对同一 manager 只挂一次。迁表后本文件零改动全绿即行为不变证明。

const h = vi.hoisted(() => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: h.logError, debug: h.logDebug }),
}));
vi.mock('../../../src/host/platform', () => ({ broadcastToRenderer: vi.fn() }));

import { registerTaskHandlers } from '../../../src/host/ipc/task.ipc';

type Handler = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;

function makeManager() {
  return Object.assign(new EventEmitter(), {
    startTask: vi.fn(async (..._a: unknown[]) => {}),
    interruptTask: vi.fn(async (..._a: unknown[]) => {}),
    cancelTask: vi.fn(async (..._a: unknown[]) => {}),
    getSessionState: vi.fn((..._a: unknown[]) => ({ status: 'running' })),
    cleanup: vi.fn((..._a: unknown[]) => {}),
    getStats: vi.fn(() => ({ running: 0, queued: 0, available: 1, maxConcurrent: 1 })),
  });
}

function register(getTaskManager: () => unknown): Handler {
  const handlers = new Map<string, Handler>();
  registerTaskHandlers({ handle: (ch: string, fn: Handler) => handlers.set(ch, fn) } as never, getTaskManager as never);
  return handlers.get(IPC_DOMAINS.TASK)!;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('task.ipc dispatch 特征：manager 可用', () => {
  it('start / interrupt / cancel / cleanup 委派并返回 null；getState 透传 sessionId', async () => {
    const m = makeManager();
    const call = register(() => m);
    expect(await call(null, { action: 'start', payload: { sessionId: 's1', message: 'hi', attachments: [1] } } as IPCRequest))
      .toEqual({ success: true, data: null });
    expect(m.startTask).toHaveBeenCalledWith('s1', 'hi', [1]);
    expect(await call(null, { action: 'interrupt', payload: { sessionId: 's1' } } as IPCRequest)).toEqual({ success: true, data: null });
    expect(m.interruptTask).toHaveBeenCalledWith('s1');
    expect(await call(null, { action: 'cancel', payload: { sessionId: 's1' } } as IPCRequest)).toEqual({ success: true, data: null });
    expect(m.cancelTask).toHaveBeenCalledWith('s1');
    expect(await call(null, { action: 'cleanup', payload: { sessionId: 's1' } } as IPCRequest)).toEqual({ success: true, data: null });
    expect(m.cleanup).toHaveBeenCalledWith('s1');
    expect(await call(null, { action: 'getState', payload: { sessionId: 's9' } } as IPCRequest)).toEqual({ success: true, data: { status: 'running' } });
    expect(m.getSessionState).toHaveBeenCalledWith('s9');
  });

  it('未知 action → INVALID_ACTION + Unknown action 文案', async () => {
    const call = register(() => makeManager());
    expect(await call(null, { action: 'bogus' } as IPCRequest))
      .toEqual({ success: false, error: { code: 'INVALID_ACTION', message: 'Unknown action: bogus' } });
  });

  it('抛错 → INTERNAL_ERROR（Error 取 message、非 Error 取 String）并记带 action 的日志', async () => {
    const m = makeManager();
    const call = register(() => m);
    m.startTask.mockRejectedValueOnce(new Error('queue full'));
    expect(await call(null, { action: 'start', payload: { sessionId: 's1', message: 'x' } } as IPCRequest))
      .toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'queue full' } });
    expect(h.logError).toHaveBeenLastCalledWith('Task IPC error [start]:', expect.any(Error));
    m.cleanup.mockImplementationOnce(() => {
      throw 'boom';
    });
    expect(await call(null, { action: 'cleanup', payload: { sessionId: 's1' } } as IPCRequest))
      .toEqual({ success: false, error: { code: 'INTERNAL_ERROR', message: 'boom' } });
    expect(h.logError).toHaveBeenLastCalledWith('Task IPC error [cleanup]:', 'boom');
  });

  it('事件桥对同一 manager 只挂一次', async () => {
    const m = makeManager();
    const call = register(() => m);
    await call(null, { action: 'getState', payload: { sessionId: 's1' } } as IPCRequest);
    await call(null, { action: 'cleanup', payload: { sessionId: 's1' } } as IPCRequest);
    expect(m.listenerCount('event')).toBe(1);
  });
});

describe('task.ipc dispatch 特征：manager 缺席', () => {
  it('未知 action 也返回 TASK_MANAGER_UNAVAILABLE（缺席判定先于分发），debug 按 action 只打一次', async () => {
    const call = register(() => null);
    const unavailable = {
      success: false,
      error: { code: 'TASK_MANAGER_UNAVAILABLE', message: 'TaskManager not initialized in this runtime (web mode or pre-bootstrap)' },
    };
    expect(await call(null, { action: 'bogus' } as IPCRequest)).toEqual(unavailable);
    expect(await call(null, { action: 'bogus' } as IPCRequest)).toEqual(unavailable);
    expect(h.logDebug).toHaveBeenCalledTimes(1);
    expect(h.logDebug).toHaveBeenCalledWith('Task IPC bogus: TaskManager unavailable in this mode; returning unavailable response');
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('manager 后续变可用即照常分发（每个请求重新取 manager）', async () => {
    let current: ReturnType<typeof makeManager> | null = null;
    const call = register(() => current);
    expect((await call(null, { action: 'cleanup', payload: { sessionId: 's1' } } as IPCRequest)).error?.code).toBe('TASK_MANAGER_UNAVAILABLE');
    current = makeManager();
    expect(await call(null, { action: 'cleanup', payload: { sessionId: 's1' } } as IPCRequest)).toEqual({ success: true, data: null });
    expect(current.cleanup).toHaveBeenCalledWith('s1');
  });
});
