// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition, CronServiceStats } from '../../../src/shared/contract/cron';

const listJobs = vi.fn<() => Promise<CronJobDefinition[]>>();
const getStats = vi.fn<() => Promise<CronServiceStats>>();
const getExecutions = vi.fn().mockResolvedValue([]);
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
  cleanup(); vi.clearAllMocks();
  useCronStore.setState({ jobs: [], stats: null, selectedJobId: null, error: null });
  useAppStore.setState({ showCapabilityHub: false, capabilityHubTab: 'experts', showCronCenter: false });
});

describe('SidebarCapabilityZone', () => {
  it('按能力中心、协作空间、资料库、自动化顺序渲染，且不恢复专家头像条', async () => {
    listJobs.mockResolvedValue([]); getStats.mockResolvedValue(makeStats(0)); render(<SidebarCapabilityZone />);
    const rows = [...screen.getByTestId('sidebar-capability-zone').querySelectorAll('button')];
    // 断言顺序本身，不只是数量——顺序是 IA 调整的产物（爸 2026-07-30 拍板：协作空间挪到能力中心下面）
    expect(rows.map((row) => row.dataset.testid)).toEqual([
      'sidebar-capability-hub',
      'sidebar-capability-projects',
      'sidebar-capability-library',
      'sidebar-capability-automation',
    ]);
    expect(screen.queryByTestId('sidebar-expert-recent-strip')).toBeNull();
    // 三行全部单行：静态说明和动态状态（下次运行/任务数/空态引导）都收进 title 悬浮提示，
    // 行内不再占第二行，节奏一致才有呼吸感。
    // 图标瓦片一律中性色：颜色只留给「要你处理的地方」，四行各一色等于没有重点。
    for (const row of rows) {
      expect(row.querySelectorAll('span.block').length).toBe(0);
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
  it('空态引导收进自动化行悬浮提示', async () => {
    listJobs.mockResolvedValue([]); getStats.mockResolvedValue(makeStats(0)); render(<SidebarCapabilityZone />);
    expect(screen.getByTestId('sidebar-capability-automation').getAttribute('title')).toBe('按计划自动跑，结果回来给你过目');
  });
  it('自动化右侧不显示下次运行时间，计划信息只留在悬浮提示', async () => {
    listJobs.mockResolvedValue([makeJob({ nextRunAt: Date.now() + 3_600_000 })]); getStats.mockResolvedValue(makeStats(0)); render(<SidebarCapabilityZone />);
    const automation = screen.getByTestId('sidebar-capability-automation');
    await waitFor(() => expect(automation.getAttribute('title')).toMatch(/下次 .+ · 英语单词/));
    expect(automation.textContent).not.toMatch(/\d{2}:\d{2}/);
    expect(automation.textContent).not.toContain('英语单词');
  });
  it('启用任务数收进悬浮提示，禁用任务不参与计数', async () => {
    listJobs.mockResolvedValue([makeJob({ id: 'enabled', nextRunAt: undefined }), makeJob({ id: 'disabled', enabled: false, nextRunAt: undefined })]); getStats.mockResolvedValue(makeStats(0)); render(<SidebarCapabilityZone />);
    await waitFor(() => expect(screen.getByTestId('sidebar-capability-automation').getAttribute('title')).toBe('1 个任务'));
  });
  it('只保留运行中圆点，右侧不再显示计划或待过目数字', async () => {
    listJobs.mockResolvedValue([makeJob({ nextRunAt: Date.now() + 3_600_000 })]); getStats.mockResolvedValue(makeStats(1)); render(<SidebarCapabilityZone />);
    const automation = screen.getByTestId('sidebar-capability-automation');
    expect(await screen.findByTestId('sidebar-capability-automation-running')).toBeTruthy();
    expect(screen.queryByTestId('sidebar-capability-automation-pending')).toBeNull();
    expect(automation.textContent).not.toMatch(/\d{2}:\d{2}/);
    expect(automation.getAttribute('title')).toMatch(/下次 .+ · 英语单词/);
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
