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

import { RENDERER_POLLING } from '../../../src/shared/constants';
import { useBackgroundTaskStore } from '../../../src/renderer/stores/backgroundTaskStore';

function resetStore(): void {
  useBackgroundTaskStore.setState({
    tasks: [],
    isLoading: false,
    error: null,
    readFailure: null,
    readRetryNonce: 0,
    lastLoadedAt: null,
    consecutiveReadFailures: 0,
  });
}

async function failRefresh(times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await expect(useBackgroundTaskStore.getState().refreshTasks()).rejects.toThrow();
  }
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

  it('确有任务时连续读失败到阈值才置 readFailure（状态无法确认才值得用户介入）', async () => {
    useBackgroundTaskStore.setState({
      tasks: [{ id: 'task-1', status: 'running' } as never],
    });
    invokeMock.mockRejectedValue(new Error('ledger unavailable'));

    await failRefresh(RENDERER_POLLING.BACKGROUND_TASK_READ_FAILURE_THRESHOLD);

    expect(useBackgroundTaskStore.getState().readFailure).not.toBeNull();
  });

  // C3（2026-08-05）：此前第一次异常就置 readFailure，useBackgroundTaskSync 随即
  // stopPoller 永久停摆，黄条挂着直到用户手动点重试——一次网络抖动就够。
  it('一次异常不置黄条，退避重试期间保持沉默', async () => {
    useBackgroundTaskStore.setState({
      tasks: [{ id: 'task-1', status: 'running' } as never],
    });
    invokeMock.mockRejectedValue(new Error('ledger unavailable'));

    await failRefresh(RENDERER_POLLING.BACKGROUND_TASK_READ_FAILURE_THRESHOLD - 1);

    const state = useBackgroundTaskStore.getState();
    expect(state.readFailure).toBeNull();
    expect(state.error).toBe('ledger unavailable');
    expect(state.consecutiveReadFailures).toBe(
      RENDERER_POLLING.BACKGROUND_TASK_READ_FAILURE_THRESHOLD - 1,
    );
  });

  it('阈值前恢复：计数归零，黄条从未出现', async () => {
    useBackgroundTaskStore.setState({
      tasks: [{ id: 'task-1', status: 'running' } as never],
    });
    invokeMock.mockRejectedValue(new Error('ledger unavailable'));
    await failRefresh(RENDERER_POLLING.BACKGROUND_TASK_READ_FAILURE_THRESHOLD - 1);

    invokeMock.mockResolvedValue({ success: true, data: [{ id: 'task-1', status: 'running' }] });
    await useBackgroundTaskStore.getState().refreshTasks();

    const state = useBackgroundTaskStore.getState();
    expect(state.readFailure).toBeNull();
    expect(state.consecutiveReadFailures).toBe(0);
  });

  it('手动重试重新给满容忍次数（否则重试一失败就又立刻停摆）', async () => {
    useBackgroundTaskStore.setState({
      tasks: [{ id: 'task-1', status: 'running' } as never],
    });
    invokeMock.mockRejectedValue(new Error('ledger unavailable'));
    await failRefresh(RENDERER_POLLING.BACKGROUND_TASK_READ_FAILURE_THRESHOLD);
    expect(useBackgroundTaskStore.getState().readFailure).not.toBeNull();

    useBackgroundTaskStore.getState().requestStatusReadRetry();
    expect(useBackgroundTaskStore.getState().consecutiveReadFailures).toBe(0);

    await failRefresh(1);
    expect(useBackgroundTaskStore.getState().readFailure).toBeNull();
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
