// @vitest-environment jsdom
//
// backgroundTaskStore.readFailure 置位条件（2026-08-04 概览四模块 · C.11）：
// 0 rows ≠ failure——空台账读取失败只是「没有任务」，不置用户可见的 readFailure；
// 只有确有任务、状态无法确认时才置位。成功读取（哪怕 0 rows）必须清除。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => true, invoke: vi.fn() },
  invoke: vi.fn(),
}));

vi.mock('../../../src/renderer/services/typedInvoke', () => ({
  typedInvokeDomain: invokeMock,
}));

import { useBackgroundTaskStore } from '../../../src/renderer/stores/backgroundTaskStore';

function resetStore(): void {
  useBackgroundTaskStore.setState({
    tasks: [],
    isLoading: false,
    error: null,
    readFailure: null,
    readRetryNonce: 0,
    lastLoadedAt: null,
  });
}

describe('backgroundTaskStore readFailure 置位条件', () => {
  beforeEach(() => {
    resetStore();
    invokeMock.mockReset();
  });

  it('空台账（0 rows）读取失败不置 readFailure，只记 error', async () => {
    invokeMock.mockRejectedValue(new Error('ledger unavailable'));

    await expect(useBackgroundTaskStore.getState().refreshTasks()).rejects.toThrow();

    const state = useBackgroundTaskStore.getState();
    expect(state.readFailure).toBeNull();
    expect(state.error).toBe('ledger unavailable');
  });

  it('确有任务时读取失败才置 readFailure（状态无法确认才值得用户介入）', async () => {
    useBackgroundTaskStore.setState({
      tasks: [{ id: 'task-1', status: 'running' } as never],
    });
    invokeMock.mockRejectedValue(new Error('ledger unavailable'));

    await expect(useBackgroundTaskStore.getState().refreshTasks()).rejects.toThrow();

    expect(useBackgroundTaskStore.getState().readFailure).not.toBeNull();
  });

  it('成功读取（哪怕 0 rows）清除既有 readFailure', async () => {
    useBackgroundTaskStore.setState({
      tasks: [{ id: 'task-1', status: 'running' } as never],
      readFailure: { message: 'x', failedAt: Date.now() },
    });
    invokeMock.mockResolvedValue({ success: true, data: [] });

    await useBackgroundTaskStore.getState().refreshTasks();

    const state = useBackgroundTaskStore.getState();
    expect(state.readFailure).toBeNull();
    expect(state.tasks).toEqual([]);
  });
});
