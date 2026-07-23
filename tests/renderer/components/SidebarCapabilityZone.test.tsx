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
  useAppStore.setState({ showCapabilityHub: false, capabilityHubTab: 'experts' });
});

describe('SidebarCapabilityZone', () => {
  it('能力区只有能力中心与资料库两个槽位，自动化不再单列一行', async () => {
    listJobs.mockResolvedValue([]);
    getStats.mockResolvedValue(makeStats(0));
    render(<SidebarCapabilityZone />);

    expect(screen.getByTestId('sidebar-capability-hub')).toBeTruthy();
    expect(screen.getByTestId('sidebar-capability-library')).toBeTruthy();
    // 自动化是能力中心的一个 tab，并列一行会变成第二个入口（ADR-049）
    expect(screen.queryByTestId('sidebar-capability-automation')).toBeNull();
    expect(
      screen.getByTestId('sidebar-capability-zone').querySelectorAll('button'),
    ).toHaveLength(2);
    await waitFor(() => {
      expect(screen.getByText('专家 · 技能 · 连接器')).toBeTruthy();
    });
    expect(screen.queryByTestId('sidebar-capability-automation-running')).toBeNull();
  });

  it('副文案恒为能力构成，不被自动化状态挤掉', async () => {
    listJobs.mockResolvedValue([makeJob({ nextRunAt: Date.now() + 3_600_000 })]);
    getStats.mockResolvedValue(makeStats(0));
    render(<SidebarCapabilityZone />);
    await waitFor(() => {
      expect(useCronStore.getState().jobs.length).toBe(1);
    });
    expect(screen.getByText('专家 · 技能 · 连接器')).toBeTruthy();
    expect(screen.queryByText(/下次 /)).toBeNull();
    expect(screen.queryByText('1 个任务')).toBeNull();
  });

  it('有运行中任务时在能力中心图标上渲染 running 圆点', async () => {
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

  it('能力中心入口打开专家 tab', () => {
    listJobs.mockResolvedValue([]);
    getStats.mockResolvedValue(makeStats(0));
    render(<SidebarCapabilityZone />);

    screen.getByTestId('sidebar-capability-hub').click();
    expect(useAppStore.getState().showCapabilityHub).toBe(true);
    expect(useAppStore.getState().capabilityHubTab).toBe('experts');
  });

  it('有待过目时角标挂在能力中心行上（A4，提醒不随自动化槽位一起消失）', async () => {
    listJobs.mockResolvedValue([makeJob({ nextRunAt: Date.now() + 3_600_000 })]);
    getStats.mockResolvedValue(makeStats(0));
    countPendingReview.mockResolvedValue(2);
    render(<SidebarCapabilityZone />);
    const badge = await waitFor(() => screen.getByTestId('sidebar-capability-automation-pending'));
    expect(badge.textContent).toBe('2');
    expect(badge.getAttribute('title')).toBe('2 条待过目');
    expect(screen.getByTestId('sidebar-capability-hub').contains(badge)).toBe(true);
  });
});
