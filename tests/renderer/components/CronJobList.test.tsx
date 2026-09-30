// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';

vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    listJobs: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue(null),
    getExecutions: vi.fn().mockResolvedValue([]),
  },
}));

import { CronJobList } from '../../../src/renderer/components/features/cron/CronJobList';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

function makeJob(overrides: Partial<CronJobDefinition>): CronJobDefinition {
  return {
    id: 'job-1',
    runsOn: 'local',
    name: '英语单词',
    scheduleType: 'cron',
    schedule: { type: 'cron', expression: '30 8 * * *' },
    action: { type: 'agent', agentType: 'default', prompt: '每天推荐 5 个英语单词' },
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

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
    copyingJobId: null,
    error: null,
  });
});

afterEach(() => {
  cleanup();
});

describe('CronJobList 人话副标题 + 触发源 chip', () => {
  it('cron 表达式副标题翻成「每天 08:30」，chip 显示定时', () => {
    useCronStore.setState({ jobs: [makeJob({})] });
    render(<CronJobList />);
    expect(screen.getByTestId('cron-job-schedule-summary').textContent).toBe('每天 08:30');
    expect(screen.getByTestId('cron-job-trigger-kind').textContent).toBe('定时');
  });

  it('工作日形态：0 15 * * 1-5 → 工作日 15:00', () => {
    useCronStore.setState({
      jobs: [makeJob({ schedule: { type: 'cron', expression: '0 15 * * 1-5' } })],
    });
    render(<CronJobList />);
    expect(screen.getByTestId('cron-job-schedule-summary').textContent).toBe('工作日 15:00');
  });

  it('覆盖不了的 cron 形态回退原表达式', () => {
    useCronStore.setState({
      jobs: [makeJob({ schedule: { type: 'cron', expression: '0 9 * * 1,3,5' } })],
    });
    render(<CronJobList />);
    expect(screen.getByTestId('cron-job-schedule-summary').textContent).toBe('0 9 * * 1,3,5');
  });

  it('every 调度：每 2 小时 + 循环 chip', () => {
    useCronStore.setState({
      jobs: [makeJob({
        scheduleType: 'every',
        schedule: { type: 'every', interval: 2, unit: 'hours' },
      })],
    });
    render(<CronJobList />);
    expect(screen.getByTestId('cron-job-schedule-summary').textContent).toBe('每 2 小时');
    expect(screen.getByTestId('cron-job-trigger-kind').textContent).toBe('循环');
  });

  it('心跳任务 chip 显示心跳（agent.context.heartbeatTask）', () => {
    useCronStore.setState({
      jobs: [makeJob({
        action: { type: 'agent', agentType: 'default', prompt: '巡检', context: { heartbeatTask: true } },
      })],
    });
    render(<CronJobList />);
    expect(screen.getByTestId('cron-job-trigger-kind').textContent).toBe('心跳');
  });

  it('事件监听任务 chip 显示事件（agent.context.externalWatch）', () => {
    useCronStore.setState({
      jobs: [makeJob({
        action: {
          type: 'agent',
          agentType: 'default',
          prompt: '盯日历',
          context: { externalWatch: { source: 'feishu-calendar', calendarId: 'cal-1' } },
        },
      })],
    });
    render(<CronJobList />);
    expect(screen.getByTestId('cron-job-trigger-kind').textContent).toBe('事件');
  });

  it('任务名右侧显示图标文字位置 pill，并可按全部/本地/云端分段筛选', () => {
    useCronStore.setState({
      jobs: [
        makeJob({ id: 'local-job', name: '本地任务', runsOn: 'local' }),
        makeJob({ id: 'cloud-job', name: '云端任务', runsOn: 'cloud' }),
      ],
    });
    render(<CronJobList />);
    expect(screen.getByTestId('cron-runs-on-pill-local').textContent).toContain('本地');
    expect(screen.getByTestId('cron-runs-on-pill-cloud').textContent).toContain('云端');

    fireEvent.click(screen.getByTestId('cron-location-filter-cloud'));
    expect(screen.queryByText('本地任务')).toBeNull();
    expect(screen.getByText('云端任务')).toBeTruthy();
  });
});
