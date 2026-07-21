// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition, CronServiceStats } from '../../../src/shared/contract/cron';

const listJobs = vi.fn<() => Promise<CronJobDefinition[]>>();
const getStats = vi.fn<() => Promise<CronServiceStats>>();
const getExecutions = vi.fn().mockResolvedValue([]);

const countPendingReview = vi.fn<() => Promise<number>>().mockResolvedValue(0);

vi.mock('../../../src/renderer/services/sessionAutomationClient', () => ({
  sessionAutomationClient: {
    countPendingReview: () => countPendingReview(),
  },
}));

vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    listJobs: (...args: unknown[]) => listJobs(...(args as [])),
    getStats: (...args: unknown[]) => getStats(...(args as [])),
    getExecutions: (...args: unknown[]) => getExecutions(...(args as [])),
  },
}));

import { SidebarCapabilityZone } from '../../../src/renderer/components/features/sidebar/SidebarCapabilityZone';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';

function makeJob(overrides: Partial<CronJobDefinition>): CronJobDefinition {
  return {
    id: 'job-1',
    name: '英语单词',
    scheduleType: 'cron',
    schedule: { type: 'cron', expression: '30 8 * * *' },
    action: { type: 'agent', agentType: 'general', prompt: '每天推荐 5 个英语单词' },
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeStats(running: number): CronServiceStats {
  return {
    totalJobs: 1,
    activeJobs: 1,
    jobsByStatus: {
      pending: 0,
      running,
      completed: 0,
      failed: 0,
      cancelled: 0,
      paused: 0,
      interrupted: 0,
    },
    totalExecutions: 0,
    successfulExecutions: 0,
    failedExecutions: 0,
    successRate: 0,
    totalHeartbeats: 0,
    healthyHeartbeats: 0,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  countPendingReview.mockResolvedValue(0);
  useCronStore.setState({ jobs: [], stats: null, selectedJobId: null, error: null });
});

describe('SidebarCapabilityZone', () => {
  it('无任务时显示空态引导文案', async () => {
    listJobs.mockResolvedValue([]);
    getStats.mockResolvedValue(makeStats(0));
    render(<SidebarCapabilityZone />);
    expect(screen.getByTestId('sidebar-capability-automation')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText('按计划自动跑，结果回来给你过目')).toBeTruthy();
    });
    expect(screen.queryByTestId('sidebar-capability-automation-running')).toBeNull();
  });

  it('有未来任务时副文案显示下次时间与名称', async () => {
    const future = Date.now() + 60 * 60 * 1000;
    listJobs.mockResolvedValue([makeJob({ nextRunAt: future })]);
    getStats.mockResolvedValue(makeStats(0));
    render(<SidebarCapabilityZone />);
    await waitFor(() => {
      expect(screen.getByText(/下次 .+ · 英语单词/)).toBeTruthy();
    });
  });

  it('启用任务无 nextRunAt 时回退到任务计数', async () => {
    listJobs.mockResolvedValue([makeJob({ nextRunAt: undefined })]);
    getStats.mockResolvedValue(makeStats(0));
    render(<SidebarCapabilityZone />);
    await waitFor(() => {
      expect(screen.getByText('1 个任务')).toBeTruthy();
    });
  });

  it('禁用任务不参与副文案与计数', async () => {
    listJobs.mockResolvedValue([
      makeJob({ enabled: false, nextRunAt: Date.now() + 3_600_000 }),
    ]);
    getStats.mockResolvedValue(makeStats(0));
    render(<SidebarCapabilityZone />);
    // 先等数据真正流入 store，再断言空文案仍在（防初始空态竞态假绿）
    await waitFor(() => {
      expect(useCronStore.getState().jobs.length).toBe(1);
    });
    expect(screen.getByText('按计划自动跑，结果回来给你过目')).toBeTruthy();
    expect(screen.queryByText(/下次 /)).toBeNull();
  });

  it('有运行中任务时渲染 running 圆点', async () => {
    listJobs.mockResolvedValue([makeJob({})]);
    getStats.mockResolvedValue(makeStats(1));
    render(<SidebarCapabilityZone />);
    await waitFor(() => {
      expect(screen.getByTestId('sidebar-capability-automation-running')).toBeTruthy();
    });
  });

  it('资料库槽位渲染并点击打开资料库面板', async () => {
    listJobs.mockResolvedValue([]);
    getStats.mockResolvedValue(makeStats(0));
    render(<SidebarCapabilityZone />);

    const entry = screen.getByTestId('sidebar-capability-library');
    expect(entry.textContent).toContain('资料库');
    expect(entry.textContent).toContain('项目资产');

    expect(useAppStore.getState().showLibraryPanel).toBe(false);
    entry.click();
    expect(useAppStore.getState().showLibraryPanel).toBe(true);
    useAppStore.getState().setShowLibraryPanel(false);
  });

  it('有待过目时渲染角标且副文案切待过目（A4）', async () => {
    listJobs.mockResolvedValue([makeJob({ nextRunAt: Date.now() + 3_600_000 })]);
    getStats.mockResolvedValue(makeStats(0));
    countPendingReview.mockResolvedValue(2);
    render(<SidebarCapabilityZone />);
    await waitFor(() => {
      expect(screen.getByTestId('sidebar-capability-automation-pending').textContent).toBe('2');
    });
    // 待过目优先于下次运行
    expect(screen.getByText('2 条待过目')).toBeTruthy();
    expect(screen.queryByText(/下次 /)).toBeNull();
  });
});
