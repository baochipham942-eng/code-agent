// @vitest-environment jsdom
// N-FIX-NOTIFY-NEEDS-INPUT-FOREGROUND-BANNER-FU1-RUNSTATE：批准停车审批、命令跑完后，
// 自动化中心「运行记录」里该行必须自己从「运行中」翻成「已完成」，不用切 tab / 重开页面。
// 面板挂真 CronCenterPanel + 真 cronStore，只把 cronClient / ipc 当作 host 边界打桩：
// host 侧行状态由 hostStatus 变量控制（host 已被 cronParkedApprovalRunState 证明会写 completed）。
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain,
    invoke: vi.fn().mockResolvedValue([]),
    on: vi.fn().mockReturnValue(() => undefined),
  },
}));
vi.mock('../../../src/renderer/utils/budgetSettingsNavigation', () => ({ openBudgetSettings: vi.fn() }));
vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    listJobs: vi.fn().mockResolvedValue([
      { id: 'job-1', name: '停车审批测试', runsOn: 'local', scheduleType: 'cron', schedule: { type: 'cron', expression: '30 8 * * *' }, action: { type: 'agent', agentType: 'default', prompt: 'x' }, enabled: true, createdAt: 1, updatedAt: 1 },
    ]),
    getStats: vi.fn().mockResolvedValue(null),
    getExecutions: vi.fn(),
    getRecentExecutions: vi.fn(),
  },
}));
vi.mock('../../../src/renderer/components/features/cron/AutomationReviewInbox', () => ({
  AutomationReviewInbox: () => <div data-testid="stub-inbox" />,
}));
vi.mock('../../../src/renderer/components/features/cron/CronJobEditor', () => ({ CronJobEditor: () => null }));
vi.mock('../../../src/renderer/components/features/settings/WebModeBanner', () => ({ WebModeBanner: () => null }));

import { CronCenterPanel } from '../../../src/renderer/components/features/cron/CronCenterPanel';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import { cronClient } from '../../../src/renderer/services/cronClient';

let hostStatus: 'running' | 'completed' = 'running';
const hostRow = () => ({
  id: 'exec-1', jobId: 'job-1', status: hostStatus, scheduledAt: 1, startedAt: 1, retryAttempt: 0,
  ...(hostStatus === 'completed' ? { completedAt: 2, duration: 1 } : {}),
});

beforeEach(() => {
  hostStatus = 'running';
  window.history.replaceState(null, '', '/?cronTab=runs');
  invokeDomain.mockReset();
  invokeDomain.mockImplementation((_d: string, action: string) =>
    Promise.resolve(action === 'listAwaitingApprovalRuns' ? [] : { scopes: { unattended: { currentCost: 0, maxBudget: 3, usagePercentage: 0 } } }));
  vi.mocked(cronClient.getExecutions).mockImplementation(async () => [hostRow()] as never);
  vi.mocked(cronClient.getRecentExecutions).mockImplementation(async () => [hostRow()] as never);
  useCronStore.setState({
    jobs: [], stats: null, latestExecutions: {}, executionsByJobId: {}, selectedJobId: null,
    filterMode: 'all', searchQuery: '', isLoading: false, isEditorOpen: false,
    editingJobId: null, copyingJobId: null, error: null, recentExecutions: [],
  });
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

const recentFetches = () => vi.mocked(cronClient.getRecentExecutions).mock.calls.length;

describe('运行记录状态自动刷新', () => {
  it('host 把执行写成 completed 后，运行记录行不切 tab 自己翻成「已完成」', async () => {
    render(<CronCenterPanel onClose={() => undefined} />);
    await vi.waitFor(() => {
      expect(screen.getByTestId('cron-execution-table-scroll').textContent).toContain('运行中');
    });
    console.log(`[PANEL before] ${screen.getByTestId('cron-execution-table-scroll').textContent}`);

    hostStatus = 'completed'; // 批准 → 命令跑完 → host 行已是 completed
    await vi.waitFor(
      () => {
        const text = screen.getByTestId('cron-execution-table-scroll').textContent ?? '';
        expect(text).not.toContain('运行中');
        expect(text).toContain('完成');
      },
      { timeout: 5000 },
    );
    console.log(`[PANEL after] ${screen.getByTestId('cron-execution-table-scroll').textContent}`);
  });

  it('没有 running 执行时不发起任何执行记录轮询（无额外请求）', async () => {
    hostStatus = 'completed';
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<CronCenterPanel onClose={() => undefined} />);
      await vi.waitFor(() => {
        expect(screen.getByTestId('cron-execution-table-scroll').textContent).toContain('完成');
      });
      const baseline = recentFetches();
      await vi.advanceTimersByTimeAsync(7000);
      expect(recentFetches()).toBe(baseline);
      expect(
        invokeDomain.mock.calls.filter(([, action]) => action === 'listAwaitingApprovalRuns'),
      ).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
