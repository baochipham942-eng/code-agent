// ============================================================================
// cronStore.executionOrder.test.ts — N-FIX-FIX-NOTIFY-NEEDS-INPUT-FOREGROUND-BANNER-FU1-RUNSTATE
//
// FB-591：host 的 getExecutions 契约是旧→新（cronPersistence LIMIT+reverse），
// store 必须归一成新→旧：详情头「最近」取 index 0，历史表第一行是最新的那次。
// 25 行升序 mock（最旧 interrupted、最新 completed）下，latest 不得再是「已中断」。
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobExecution, CronJobStatus } from '../../../src/shared/contract';

vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    listJobs: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue(null),
    getExecutions: vi.fn().mockResolvedValue([]),
    getRecentExecutions: vi.fn().mockResolvedValue([]),
  },
}));

import { cronClient } from '../../../src/renderer/services/cronClient';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

let nextId = 0;
function makeRow(scheduledAt: number, status: CronJobStatus): CronJobExecution {
  nextId += 1;
  return {
    id: `exec-${nextId}`,
    jobId: 'job-1',
    status,
    scheduledAt,
    startedAt: scheduledAt + 1_000,
    ...(status === 'completed' ? { completedAt: scheduledAt + 61_000, duration: 60_000 } : {}),
    retryAttempt: 0,
  };
}

beforeEach(() => {
  nextId = 0;
  useCronStore.setState({
    jobs: [], stats: null, latestExecutions: {}, executionsByJobId: {}, selectedJobId: null,
    filterMode: 'all', searchQuery: '', isLoading: false, isEditorOpen: false,
    editingJobId: null, copyingJobId: null, error: null, recentExecutions: [],
  });
});

describe('loadExecutions 执行顺序归一（新→旧）', () => {
  it('25 行升序（最旧 interrupted、最新 completed）→ latest 是 completed，数组首行最新、末行最旧', async () => {
    // host 侧真实形状：升序的旧→新窗口
    const ascending = Array.from({ length: 25 }, (_, i) =>
      makeRow(1_760_000_000_000 + i * 3_600_000, i === 0 ? 'interrupted' : 'completed'));
    vi.mocked(cronClient.getExecutions).mockResolvedValue(ascending as never);

    await useCronStore.getState().loadExecutions('job-1');

    const state = useCronStore.getState();
    expect(state.latestExecutions['job-1']?.status).toBe('completed');
    expect(state.latestExecutions['job-1']?.scheduledAt).toBe(1_760_000_000_000 + 24 * 3_600_000);
    const stored = state.executionsByJobId['job-1'];
    expect(stored).toHaveLength(25);
    expect(stored[0]?.scheduledAt).toBe(1_760_000_000_000 + 24 * 3_600_000); // 最新在最前
    expect(stored[24]?.scheduledAt).toBe(1_760_000_000_000); // 最旧在最后
    expect(stored[24]?.status).toBe('interrupted');
  });

  it('mock 已是新→旧（既有用例形状）时保持原序', async () => {
    const newestFirst = [makeRow(3_000, 'completed'), makeRow(2_000, 'failed'), makeRow(1_000, 'interrupted')];
    vi.mocked(cronClient.getExecutions).mockResolvedValue(newestFirst as never);

    await useCronStore.getState().loadExecutions('job-1');

    const state = useCronStore.getState();
    expect(state.executionsByJobId['job-1'].map((row) => row.scheduledAt)).toEqual([3_000, 2_000, 1_000]);
    expect(state.latestExecutions['job-1']?.scheduledAt).toBe(3_000);
  });

  it('空数组 → latest 为 null', async () => {
    vi.mocked(cronClient.getExecutions).mockResolvedValue([] as never);

    await useCronStore.getState().loadExecutions('job-1');

    const state = useCronStore.getState();
    expect(state.executionsByJobId['job-1']).toEqual([]);
    expect(state.latestExecutions['job-1']).toBeNull();
  });
});
