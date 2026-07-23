// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition, CronServiceStats } from '../../../src/shared/contract/cron';

const listJobs = vi.fn<() => Promise<CronJobDefinition[]>>();
const getStats = vi.fn<() => Promise<CronServiceStats>>();
const getExecutions = vi.fn().mockResolvedValue([]);
const countPendingReview = vi.fn<() => Promise<number>>().mockResolvedValue(0);
vi.mock('../../../src/renderer/services/sessionAutomationClient', () => ({ sessionAutomationClient: { countPendingReview: () => countPendingReview() } }));
vi.mock('../../../src/renderer/services/cronClient', () => ({ cronClient: { listJobs: (...args: unknown[]) => listJobs(...(args as [])), getStats: (...args: unknown[]) => getStats(...(args as [])), getExecutions: (...args: unknown[]) => getExecutions(...(args as [])) } }));

import { SidebarCapabilityZone } from '../../../src/renderer/components/features/sidebar/SidebarCapabilityZone';
import { useCronStore } from '../../../src/renderer/stores/cronStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';

function makeJob(overrides: Partial<CronJobDefinition>): CronJobDefinition {
  return { id: 'job-1', name: '英语单词', scheduleType: 'cron', schedule: { type: 'cron', expression: '30 8 * * *' }, action: { type: 'agent', agentType: 'general', prompt: '每天推荐 5 个英语单词' }, enabled: true, createdAt: 1, updatedAt: 1, ...overrides };
}
function makeStats(running: number): CronServiceStats {
  return { totalJobs: 1, activeJobs: 1, jobsByStatus: { pending: 0, running, completed: 0, failed: 0, cancelled: 0, paused: 0, interrupted: 0 }, totalExecutions: 0, successfulExecutions: 0, failedExecutions: 0, successRate: 0, totalHeartbeats: 0, healthyHeartbeats: 0 };
}
afterEach(() => {
  cleanup(); vi.clearAllMocks(); countPendingReview.mockResolvedValue(0);
  useCronStore.setState({ jobs: [], stats: null, selectedJobId: null, error: null });
  useAppStore.setState({ showCapabilityHub: false, capabilityHubTab: 'experts', showCronCenter: false });
});

describe('SidebarCapabilityZone', () => {
  it('按能力中心、资料库、自动化顺序渲染，且不恢复专家头像条', async () => {
    listJobs.mockResolvedValue([]); getStats.mockResolvedValue(makeStats(0)); render(<SidebarCapabilityZone />);
    const rows = [...screen.getByTestId('sidebar-capability-zone').querySelectorAll('button')];
    // 断言顺序本身，不只是数量——顺序是这次 IA 调整的产物
    expect(rows.map((row) => row.dataset.testid)).toEqual([
      'sidebar-capability-hub',
      'sidebar-capability-library',
      'sidebar-capability-automation',
    ]);
    expect(screen.queryByTestId('sidebar-expert-recent-strip')).toBeNull();
    await waitFor(() => expect(screen.getByText('专家 · 技能 · 连接器')).toBeTruthy());
  });
  it('资料库槽位渲染并点击打开资料库面板', () => {
    listJobs.mockResolvedValue([]); getStats.mockResolvedValue(makeStats(0)); render(<SidebarCapabilityZone />);
    const entry = screen.getByTestId('sidebar-capability-library');
    expect(entry.textContent).toContain('资料库');
    expect(entry.textContent).toContain('可带进对话');
    expect(useAppStore.getState().showLibraryPanel).toBe(false);
    entry.click();
    expect(useAppStore.getState().showLibraryPanel).toBe(true);
    useAppStore.getState().setShowLibraryPanel(false);
  });
  it('空态给出自动化引导', async () => {
    listJobs.mockResolvedValue([]); getStats.mockResolvedValue(makeStats(0)); render(<SidebarCapabilityZone />);
    expect(await screen.findByText('按计划自动跑，结果回来给你过目')).toBeTruthy();
  });
  it('显示下次运行时间和任务名', async () => {
    listJobs.mockResolvedValue([makeJob({ nextRunAt: Date.now() + 3_600_000 })]); getStats.mockResolvedValue(makeStats(0)); render(<SidebarCapabilityZone />);
    // 连「下次 {time} · {name}」的整体格式一起钉，只验任务名会让时间渲染坏掉也不报
    await waitFor(() => expect(screen.getByText(/下次 .+ · 英语单词/)).toBeTruthy());
  });
  it('显示启用任务数，禁用任务不参与计数', async () => {
    listJobs.mockResolvedValue([makeJob({ id: 'enabled', nextRunAt: undefined }), makeJob({ id: 'disabled', enabled: false, nextRunAt: undefined })]); getStats.mockResolvedValue(makeStats(0)); render(<SidebarCapabilityZone />);
    expect(await screen.findByText('1 个任务')).toBeTruthy();
  });
  it('running 圆点和待过目角标都属于自动化行，且待过目优先于下次运行', async () => {
    listJobs.mockResolvedValue([makeJob({ nextRunAt: Date.now() + 3_600_000 })]); getStats.mockResolvedValue(makeStats(1)); countPendingReview.mockResolvedValue(2); render(<SidebarCapabilityZone />);
    const automation = screen.getByTestId('sidebar-capability-automation');
    expect(await screen.findByTestId('sidebar-capability-automation-running')).toBeTruthy();
    const badge = await screen.findByTestId('sidebar-capability-automation-pending');
    expect(badge.textContent).toBe('2');
    expect(automation.contains(badge)).toBe(true);
    expect(screen.getByTestId('sidebar-capability-hub').contains(badge)).toBe(false);
    // 副文案优先级：有待过目就压过「下次运行」
    expect(screen.getByText('2 条待过目')).toBeTruthy();
    expect(screen.queryByText(/下次 /)).toBeNull();
  });
  it('能力中心入口仍打开专家 tab', () => {
    listJobs.mockResolvedValue([]); getStats.mockResolvedValue(makeStats(0)); render(<SidebarCapabilityZone />);
    screen.getByTestId('sidebar-capability-hub').click();
    expect(useAppStore.getState()).toMatchObject({ showCapabilityHub: true, capabilityHubTab: 'experts' });
  });
  it('自动化入口打开独立面板', () => {
    listJobs.mockResolvedValue([]); getStats.mockResolvedValue(makeStats(0)); render(<SidebarCapabilityZone />);
    screen.getByTestId('sidebar-capability-automation').click();
    expect(useAppStore.getState().showCronCenter).toBe(true);
  });
});
