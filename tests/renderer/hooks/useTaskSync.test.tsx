// @vitest-environment jsdom
// useTaskSync 的 renderHook 测试：store + IPC 订阅 + 轮询 的较重 hook 示范。
// mock taskStore（Zustand 动作）+ ipcService（事件订阅）+ window.domainAPI。
// 覆盖挂载同步、domainAPI 缺失跳过、IPC 事件三类派发 + 未知类型、轮询、
// 卸载清理、performSync 错误兜底，以及 3 个工具 hook 的派生。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const store = vi.hoisted(() => ({
  refreshStates: vi.fn(async () => {}),
  refreshStats: vi.fn(async () => {}),
  updateSessionState: vi.fn(),
  updateStats: vi.fn(),
  getSessionState: vi.fn((_id: string) => ({ status: 'running' as const })),
  sessionStates: {} as Record<string, unknown>,
  stats: { running: 0, queued: 0, available: 4, maxConcurrent: 4 },
}));
const ipc = vi.hoisted(() => ({
  isAvailable: vi.fn(() => true),
  on: vi.fn((_ch: string, cb: (e: unknown) => void) => {
    ipc._handler = cb;
    return ipc._unsub;
  }),
  _handler: null as null | ((e: unknown) => void),
  _unsub: vi.fn(),
}));

vi.mock('../../../src/renderer/stores/taskStore', () => ({ useTaskStore: () => store }));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => ipc.isAvailable(), on: (ch: string, cb: (e: unknown) => void) => ipc.on(ch, cb) },
}));
vi.mock('../../../src/renderer/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { useTaskSync, useSessionTaskState, useHasRunningTasks, useTaskConcurrency } from '../../../src/renderer/hooks/useTaskSync';

beforeEach(() => {
  vi.clearAllMocks();
  store.refreshStates.mockResolvedValue(undefined);
  store.refreshStats.mockResolvedValue(undefined);
  store.sessionStates = {};
  store.stats = { running: 0, queued: 0, available: 4, maxConcurrent: 4 };
  ipc.isAvailable.mockReturnValue(true);
  ipc._handler = null;
  (window as unknown as { domainAPI?: unknown }).domainAPI = {};
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as { domainAPI?: unknown }).domainAPI;
});

describe('挂载同步', () => {
  it('enabled 时挂载即并行拉取 states+stats 并写 lastSyncTime', async () => {
    const { result } = renderHook(() => useTaskSync({ pollInterval: 0 }));
    await waitFor(() => expect(result.current.lastSyncTime).not.toBeNull());
    expect(store.refreshStates).toHaveBeenCalled();
    expect(store.refreshStats).toHaveBeenCalled();
    expect(result.current.isSyncing).toBe(false);
  });

  it('domainAPI 不可用 → 跳过同步', async () => {
    delete (window as unknown as { domainAPI?: unknown }).domainAPI;
    renderHook(() => useTaskSync({ pollInterval: 0 }));
    await act(async () => {});
    expect(store.refreshStates).not.toHaveBeenCalled();
  });

  it('enabled=false → 不同步不订阅', async () => {
    renderHook(() => useTaskSync({ enabled: false, pollInterval: 0 }));
    await act(async () => {});
    expect(store.refreshStates).not.toHaveBeenCalled();
    expect(ipc.on).not.toHaveBeenCalled();
  });

  it('refreshStates 抛错 → 被兜底，isSyncing 复位', async () => {
    store.refreshStates.mockRejectedValue(new Error('sync boom'));
    const { result } = renderHook(() => useTaskSync({ pollInterval: 0 }));
    await waitFor(() => expect(result.current.isSyncing).toBe(false));
    expect(result.current.lastSyncTime).toBeNull(); // 失败不写时间戳
  });

  it('手动 refresh 再拉一次', async () => {
    const { result } = renderHook(() => useTaskSync({ pollInterval: 0 }));
    await waitFor(() => expect(result.current.lastSyncTime).not.toBeNull());
    store.refreshStates.mockClear();
    await act(async () => {
      await result.current.refresh();
    });
    expect(store.refreshStates).toHaveBeenCalled();
  });
});

describe('IPC 事件派发', () => {
  async function mountWithHandler() {
    const view = renderHook(() => useTaskSync({ pollInterval: 0 }));
    await waitFor(() => expect(ipc._handler).not.toBeNull());
    return view;
  }

  it('state_change → updateSessionState', async () => {
    await mountWithHandler();
    act(() => ipc._handler!({ type: 'state_change', sessionId: 's1', data: { status: 'running' } }));
    expect(store.updateSessionState).toHaveBeenCalledWith('s1', { status: 'running' });
  });

  it('stats_updated → updateStats', async () => {
    await mountWithHandler();
    act(() => ipc._handler!({ type: 'stats_updated', data: { running: 2 } }));
    expect(store.updateStats).toHaveBeenCalledWith({ running: 2 });
  });

  it('queue_update → 触发全量 refreshStates', async () => {
    await mountWithHandler();
    store.refreshStates.mockClear();
    act(() => ipc._handler!({ type: 'queue_update' }));
    expect(store.refreshStates).toHaveBeenCalled();
  });

  it('未知事件类型 → 不抛（warn 兜底）', async () => {
    await mountWithHandler();
    expect(() => act(() => ipc._handler!({ type: 'mystery' }))).not.toThrow();
  });

  it('ipc 不可用 → 不注册监听', async () => {
    ipc.isAvailable.mockReturnValue(false);
    renderHook(() => useTaskSync({ pollInterval: 0 }));
    await act(async () => {});
    expect(ipc.on).not.toHaveBeenCalled();
  });

  it('卸载 → 取消订阅', async () => {
    const { unmount } = await mountWithHandler();
    unmount();
    expect(ipc._unsub).toHaveBeenCalled();
  });
});

describe('轮询', () => {
  it('pollInterval>0 时定时重复同步', async () => {
    vi.useFakeTimers();
    renderHook(() => useTaskSync({ pollInterval: 5000 }));
    // 挂载初次同步
    await vi.waitFor(() => expect(store.refreshStates).toHaveBeenCalled());
    const initial = store.refreshStates.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(store.refreshStates.mock.calls.length).toBeGreaterThan(initial);
  });
});

describe('工具 hook', () => {
  it('useSessionTaskState：null → idle', () => {
    const { result } = renderHook(() => useSessionTaskState(null));
    expect(result.current).toEqual({ status: 'idle', queuePosition: undefined });
  });

  it('useSessionTaskState：命中 sessionStates 优先', () => {
    store.sessionStates = { s1: { status: 'queued' } };
    const { result } = renderHook(() => useSessionTaskState('s1'));
    expect(result.current).toEqual({ status: 'queued' });
  });

  it('useSessionTaskState：未命中 → 回退 getSessionState', () => {
    store.sessionStates = {};
    const { result } = renderHook(() => useSessionTaskState('s2'));
    expect(store.getSessionState).toHaveBeenCalledWith('s2');
    expect(result.current).toEqual({ status: 'running' });
  });

  it('useHasRunningTasks：running>0 为真', () => {
    store.stats = { running: 1, queued: 0, available: 3, maxConcurrent: 4 };
    expect(renderHook(() => useHasRunningTasks()).result.current).toBe(true);
  });

  it('useTaskConcurrency：派生 isFull / hasQueue', () => {
    store.stats = { running: 4, queued: 2, available: 0, maxConcurrent: 4 };
    const { result } = renderHook(() => useTaskConcurrency());
    expect(result.current).toEqual({ running: 4, queued: 2, available: 0, maxConcurrent: 4, isFull: true, hasQueue: true });
  });
});
