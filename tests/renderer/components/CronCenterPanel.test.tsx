// @vitest-environment jsdom
// D0 回归（2026-07-26 打磨批 D）：自动化页「整页无法滚动」。
// 根因：#731 叠加三个 shrink-0 顶区（状态条/收件箱/推荐模板）后，底部工作台
// grid overflow-hidden 且全页没有任何页级滚动容器，矮窗口下顶区吃光高度、
// 列表区被压没且永远滚不到。本测试锁住布局契约：
// 1) header 以下存在页级滚动容器（overflow-y-auto），且顶区与工作台都在其中；
// 2) 工作台 grid 不再 flex-1 min-h-0（会被压到 0），而是 flex-[1_0_420px]
//    （高屏占满、矮屏保底可滚）。
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    listJobs: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue(null),
    getExecutions: vi.fn().mockResolvedValue([]),
    getRecentExecutions: vi.fn().mockResolvedValue([
      { id: 'exec-1', jobId: 'job-1', status: 'completed', scheduledAt: 1, startedAt: 1, completedAt: 2, duration: 1, retryAttempt: 0 },
    ]),
  },
}));

// 重子组件打桩：本测试只锁 CronCenterPanel 的布局契约，不递归验子树。
vi.mock('../../../src/renderer/components/features/cron/AutomationReviewInbox', () => ({
  AutomationReviewInbox: () => <div data-testid="stub-inbox" />,
}));
vi.mock('../../../src/renderer/components/features/cron/CronFeaturedTemplates', () => ({
  CronFeaturedTemplates: () => <div data-testid="stub-templates" />,
}));
vi.mock('../../../src/renderer/components/features/cron/CronJobList', () => ({
  CronJobList: () => <div data-testid="stub-job-list" />,
}));
vi.mock('../../../src/renderer/components/features/cron/CronJobDetail', () => ({
  CronJobDetail: () => <div data-testid="stub-job-detail" />,
}));
vi.mock('../../../src/renderer/components/features/cron/CronJobEditor', () => ({
  CronJobEditor: () => null,
}));
vi.mock('../../../src/renderer/components/features/settings/WebModeBanner', () => ({
  WebModeBanner: () => null,
}));

import { CronCenterPanel } from '../../../src/renderer/components/features/cron/CronCenterPanel';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

beforeEach(() => {
  useCronStore.setState({
    jobs: [],
    stats: null,
    latestExecutions: {},
    executionsByJobId: {},
    selectedJobId: null,
    filterMode: 'all',
    searchQuery: '',
    isLoading: false,
    isEditorOpen: false,
    editingJobId: null,
    error: null,
    recentExecutions: [],
  });
});

afterEach(() => {
  cleanup();
});

describe('CronCenterPanel 页级滚动契约（D0）', () => {
  it('header 以下的内容区是页级滚动容器，状态条/收件箱/工作台都在其中', () => {
    render(<CronCenterPanel onClose={() => undefined} />);
    const scrollRegion = screen.getByTestId('cron-center-scroll');
    expect(scrollRegion.className).toContain('overflow-y-auto');
    expect(scrollRegion.className).toContain('flex-1');
    // 顶区与工作台都必须挂在滚动容器内，矮窗口才能滚到
    expect(scrollRegion.contains(screen.getByTestId('cron-status-bar'))).toBe(true);
    expect(scrollRegion.contains(screen.getByTestId('stub-inbox'))).toBe(true);
    expect(scrollRegion.contains(screen.getByTestId('stub-job-list'))).toBe(true);
  });

  it('工作台 grid 保底 420px 且可 grow（不再 flex-1 min-h-0 被压没）', () => {
    render(<CronCenterPanel onClose={() => undefined} />);
    const workbench = screen.getByTestId('stub-job-list').parentElement!;
    expect(workbench.className).toContain('flex-[1_0_420px]');
    expect(workbench.className).not.toContain('min-h-0');
  });
});

describe('CronCenterPanel 双 tab（批C4 WorkBuddy 式改造）', () => {
  it('默认落「定时任务」：模板区与任务工作台可见，收件箱隐藏（保活挂载）', () => {
    render(<CronCenterPanel onClose={() => undefined} />);
    expect(screen.getByTestId('cron-center-tab-jobs').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('stub-templates')).toBeTruthy();
    expect(screen.getByTestId('stub-job-list')).toBeTruthy();
    // 收件箱仍在 DOM（待过目数据源），但被 hidden 收起
    expect(screen.getByTestId('stub-inbox').parentElement!.className).toContain('hidden');
  });

  it('切「运行记录」：拉跨任务执行流并渲染任务名列，任务工作台让位', async () => {
    const { cronClient } = await import('../../../src/renderer/services/cronClient');
    // refresh() 挂载即拉任务列表并覆写 store，任务名要从 mock 供给
    vi.mocked(cronClient.listJobs).mockResolvedValue([{ id: 'job-1', name: '每日晨报' } as never]);
    render(<CronCenterPanel onClose={() => undefined} />);
    screen.getByTestId('cron-center-tab-runs').click();
    // loadRecentExecutions 异步落 store
    await vi.waitFor(() => {
      expect(cronClient.getRecentExecutions).toHaveBeenCalled();
      expect(screen.getByTestId('cron-runs-workbench')).toBeTruthy();
    });
    expect(screen.queryByTestId('stub-job-list')).toBeNull();
    expect(screen.getByTestId('stub-inbox').parentElement!.className).not.toContain('hidden');
    await vi.waitFor(() => {
      expect(screen.getByText('每日晨报')).toBeTruthy();
    });
  });
});
