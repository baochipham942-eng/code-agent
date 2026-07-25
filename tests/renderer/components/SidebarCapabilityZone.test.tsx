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
    // 「里面装了什么」从常驻副标题降级成 title 悬浮提示：静态说明那两行不再各占两行，
    // 只有自动化保留第二行——那是动态状态（下次运行/任务数/空态），不是说明文字。
    // 图标瓦片一律中性色：颜色只留给「要你处理的地方」，四行各一色等于没有重点。
    for (const row of rows) {
      const isAutomation = row.dataset.testid === 'sidebar-capability-automation';
      expect(row.querySelectorAll('span.block').length).toBe(isAutomation ? 2 : 0);
      expect(row.innerHTML).not.toMatch(/bg-(violet|indigo|amber|cyan)-500\/10/);
    }
    expect(screen.queryByText('专家 · 技能 · 连接器')).toBeNull();
    await waitFor(() => expect(
      screen.getByTestId('sidebar-capability-hub').getAttribute('title'),
    ).toBe('专家 · 技能 · 连接器'));
  });
  it('资料库槽位渲染并点击打开资料库面板', () => {
    listJobs.mockResolvedValue([]); getStats.mockResolvedValue(makeStats(0)); render(<SidebarCapabilityZone />);
    const entry = screen.getByTestId('sidebar-capability-library');
    expect(entry.textContent).toContain('资料库');
    expect(entry.getAttribute('title')).toContain('可带进对话');
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
  it('running 圆点和待过目角标都属于自动化行，副标题继续讲计划、数量只由角标讲一次', async () => {
    listJobs.mockResolvedValue([makeJob({ nextRunAt: Date.now() + 3_600_000 })]); getStats.mockResolvedValue(makeStats(1)); countPendingReview.mockResolvedValue(2); render(<SidebarCapabilityZone />);
    const automation = screen.getByTestId('sidebar-capability-automation');
    expect(await screen.findByTestId('sidebar-capability-automation-running')).toBeTruthy();
    const badge = await screen.findByTestId('sidebar-capability-automation-pending');
    expect(badge.textContent).toBe('2');
    expect(automation.contains(badge)).toBe(true);
    expect(screen.getByTestId('sidebar-capability-hub').contains(badge)).toBe(false);
    // 推翻旧断言「有待过目就压过下次运行」：那样副标题写「2 条待过目」、角标又显示 2，
    // 同一个数字讲两遍，还把唯一的计划信息挤掉了。现在角标讲数量（读屏靠 aria-label），
    // 副标题继续讲计划。裸数字回到副标题里就会红。
    expect(badge.getAttribute('aria-label')).toBe('2 条待过目');
    expect(screen.queryByText('2 条待过目')).toBeNull();
    expect(screen.getByText(/下次 .+ · 英语单词/)).toBeTruthy();
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
