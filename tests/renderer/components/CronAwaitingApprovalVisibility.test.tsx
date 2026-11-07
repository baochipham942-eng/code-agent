// @vitest-environment jsdom
// N-CRON-UNATTENDED-BASH-PARK-STUCK-VISIBLE：无人值守任务停在审批时，任务行/详情/运行记录
// 都要能看到 amber「等你批准」，且「去处理」把用户带到运行记录 tab（审批卡在收件箱顶部）。
// 面板级走真子组件（CronJobList/CronJobDetail/CronExecutionList），只打桩编辑器/收件箱/横幅。
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  // invoke/on 供 useChannelCatalog 等子树读取频道列表/监听变更，与本文无关，给空实现即可
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
      { id: 'job-1', name: '每日晨报', runsOn: 'local', scheduleType: 'cron', schedule: { type: 'cron', expression: '30 8 * * *' }, action: { type: 'agent', agentType: 'default', prompt: '晨报' }, enabled: true, createdAt: 1, updatedAt: 1 },
      { id: 'job-2', name: '周报盘点', runsOn: 'local', scheduleType: 'cron', schedule: { type: 'cron', expression: '0 9 * * 1' }, action: { type: 'agent', agentType: 'default', prompt: '周报' }, enabled: true, createdAt: 1, updatedAt: 1 },
    ]),
    getStats: vi.fn().mockResolvedValue(null),
    getExecutions: vi.fn(),
    getRecentExecutions: vi.fn().mockResolvedValue([]),
  },
}));
// 收件箱打桩并记录收到的 refreshSignal（Rework r1：停车集合变化要传导给常驻收件箱）
const inboxSignals = vi.hoisted(() => [] as unknown[]);
vi.mock('../../../src/renderer/components/features/cron/AutomationReviewInbox', () => ({
  AutomationReviewInbox: (props: { refreshSignal?: string | number }) => {
    inboxSignals.push(props.refreshSignal);
    return <div data-testid="stub-inbox" />;
  },
}));
vi.mock('../../../src/renderer/components/features/cron/CronJobEditor', () => ({
  CronJobEditor: () => null,
}));
vi.mock('../../../src/renderer/components/features/settings/WebModeBanner', () => ({
  WebModeBanner: () => null,
}));

import { CronCenterPanel } from '../../../src/renderer/components/features/cron/CronCenterPanel';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import { cronClient } from '../../../src/renderer/services/cronClient';

let awaitingRunsMock: unknown[] = [];

beforeEach(() => {
  awaitingRunsMock = [];
  inboxSignals.length = 0;
  invokeDomain.mockReset();
  invokeDomain.mockImplementation((_domain: string, action: string) => {
    if (action === 'listAwaitingApprovalRuns') return Promise.resolve(awaitingRunsMock);
    return Promise.resolve({
      scopes: { unattended: { currentCost: 0, maxBudget: 3, usagePercentage: 0 } },
    });
  });
  // loadLatestExecution 拉 jobId 最近 1 条：job-1 给 running，其余空（loadJobs 时落 latestExecutions）
  vi.mocked(cronClient.getExecutions).mockImplementation(async (jobId: string) =>
    jobId === 'job-1'
      ? [{ id: 'exec-1', jobId: 'job-1', status: 'running', scheduledAt: 1, startedAt: 1, retryAttempt: 0 }]
      : []);
  vi.mocked(cronClient.getRecentExecutions).mockResolvedValue([
    { id: 'exec-1', jobId: 'job-1', status: 'running', scheduledAt: 1, startedAt: 1, retryAttempt: 0 },
    { id: 'exec-2', jobId: 'job-2', status: 'completed', scheduledAt: 1, startedAt: 1, completedAt: 2, duration: 1, retryAttempt: 0 },
  ] as never);
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
    copyingJobId: null,
    error: null,
    recentExecutions: [],
  });
});

afterEach(() => {
  cleanup();
});

describe('无人值守等批准可见性（N-CRON-UNATTENDED-BASH-PARK-STUCK-VISIBLE）', () => {
  it('有 running 执行且该 job 停在审批：任务列表只给命中 job 换 badge，收尾后 badge 消失', async () => {
    render(<CronCenterPanel onClose={() => undefined} />);

    // 面板挂载后拉到 running 执行 → 立即发起第一轮 listAwaitingApprovalRuns
    await vi.waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith('domain:sessionAutomation', 'listAwaitingApprovalRuns', {});
    });
    awaitingRunsMock = [{ jobId: 'job-1', executionId: 'exec-1', requestId: 'req-1', requestedAt: 1 }];

    await vi.waitFor(
      () => {
        const badges = screen.getAllByTestId('cron-job-awaiting-approval');
        expect(badges).toHaveLength(1);
        expect(badges[0].textContent).toBe('等你批准');
        expect(badges[0].closest('button')!.textContent).toContain('每日晨报');
      },
      { timeout: 3000 },
    );
    const otherRow = screen.getByText('周报盘点').closest('button')!;
    expect(otherRow.querySelector('[data-testid="cron-job-awaiting-approval"]')).toBeNull();

    // Rework r1：停车集合出现 → 常驻收件箱收到变化的 refreshSignal（停车审批卡要重拉）
    expect(inboxSignals).toContain('req-1');

    // 批准/拒绝后下一轮轮询返回空 → badge 消失（2s 间隔，放宽到 3s）
    awaitingRunsMock = [];
    await vi.waitFor(
      () => {
        expect(screen.queryByTestId('cron-job-awaiting-approval')).toBeNull();
      },
      { timeout: 3000 },
    );
    // 集合清空 → 信号回到空串，收件箱随之再拉一轮（卡撤下）
    expect(inboxSignals[inboxSignals.length - 1]).toBe('');
  });

  it('没有任何 running 执行时不发起等批准轮询', async () => {
    vi.mocked(cronClient.getRecentExecutions).mockResolvedValue([
      { id: 'exec-2', jobId: 'job-2', status: 'completed', scheduledAt: 1, startedAt: 1, completedAt: 2, duration: 1, retryAttempt: 0 },
    ] as never);
    // 两个 running 信号源（latestExecutions / recentExecutions）都得是完成态
    vi.mocked(cronClient.getExecutions).mockResolvedValue([] as never);
    render(<CronCenterPanel onClose={() => undefined} />);

    // 任务 tab 的挂载刷新走 listJobs + getExecutions（每 job 最近一次），不拉运行记录；
    // 等任务列表真正渲染出来（latestExecutions 已落 store），再断言没发起过轮询。
    await vi.waitFor(() => {
      expect(screen.getByText('周报盘点')).toBeTruthy();
    });
    expect(
      invokeDomain.mock.calls.filter(([, action]) => action === 'listAwaitingApprovalRuns'),
    ).toHaveLength(0);
  });

  it('任务详情显示等批准提示，「去处理」切到运行记录 tab，运行行也带 badge（④）', async () => {
    render(<CronCenterPanel onClose={() => undefined} />);
    awaitingRunsMock = [{ jobId: 'job-1', executionId: 'exec-1', requestId: 'req-1', requestedAt: 1 }];

    await vi.waitFor(
      () => {
        expect(screen.getAllByTestId('cron-job-awaiting-approval')).toHaveLength(1);
      },
      { timeout: 3000 },
    );

    // loadJobs 后默认选中 jobs[0]（job-1），任务详情已在右侧
    expect(screen.getByTestId('cron-detail-awaiting-approval').textContent).toBe('等你批准');
    expect(screen.getByTestId('cron-detail-awaiting-approval-hint').textContent).toContain('等你批准操作');

    fireEvent.click(screen.getByTestId('cron-detail-awaiting-approval-action'));
    expect(screen.getByTestId('cron-center-tab-runs').getAttribute('aria-selected')).toBe('true');

    await vi.waitFor(
      () => {
        const execBadge = screen.getByTestId('cron-exec-awaiting-approval');
        expect(execBadge.textContent).toBe('等你批准');
      },
      { timeout: 3000 },
    );
  });
  it('⑤ 带 commandPreview：详情提示与运行行 chip 显示「等你批准：<预览>」；无预览保持原文案', async () => {
    render(<CronCenterPanel onClose={() => undefined} />);
    awaitingRunsMock = [{
      jobId: 'job-1', executionId: 'exec-1', requestId: 'req-1', requestedAt: 1,
      commandPreview: 'node scripts/refresh-wechat.js --since yesterday --verbose-long-flag',
    }];

    await vi.waitFor(
      () => {
        expect(screen.getAllByTestId('cron-job-awaiting-approval')).toHaveLength(1);
      },
      { timeout: 3000 },
    );
    const hint = screen.getByTestId('cron-detail-awaiting-approval-hint').textContent ?? '';
    expect(hint).toContain('等你批准：node scripts/refresh-wechat…');
    expect(hint).toContain('…');
    expect(hint).not.toContain('--verbose-long-flag');

    fireEvent.click(screen.getByTestId('cron-detail-awaiting-approval-action'));
    await vi.waitFor(
      () => {
        const chip = screen.getByTestId('cron-exec-awaiting-approval');
        expect(chip.textContent).toContain('等你批准：node scripts/refresh-wechat…');
        expect(chip.className).toContain('whitespace-nowrap');
        expect(chip.className).toContain('max-w-[180px]');
        expect(chip.getAttribute('title')).toContain('等你批准：node scripts/refresh-wechat.js --since yesterday --verbose-long-flag');
      },
      { timeout: 3000 },
    );
  });
});
