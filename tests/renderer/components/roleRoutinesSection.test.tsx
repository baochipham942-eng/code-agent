// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoleBoundCronJob } from '../../../src/shared/contract/roleAssets';

const invokeDomain = vi.fn();
const updateJob = vi.fn();
const triggerJob = vi.fn();

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: (...args: unknown[]) => invokeDomain(...args),
  },
}));

vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    updateJob: (...args: unknown[]) => updateJob(...args),
    triggerJob: (...args: unknown[]) => triggerJob(...args),
  },
}));

import { RoleRoutinesSection } from '../../../src/renderer/components/features/expert/RoleRoutinesSection';

const ROLE_ID = '竞品观察员';
const NEXT_AT = Date.UTC(2026, 9, 27, 1, 0, 0);
const LAST_AT = Date.UTC(2026, 9, 26, 1, 0, 0);

function sampleJobs(): RoleBoundCronJob[] {
  return [
    {
      id: 'daily-report',
      name: '晨报',
      schedule: { type: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
      enabled: true,
      nextRunAt: NEXT_AT,
      lastRunAt: LAST_AT,
      lastStatus: 'failed',
      lastError: '站点打不开',
      actionType: 'agent',
    },
    {
      id: 'weekly-report',
      name: '周报',
      schedule: { type: 'every', interval: 1, unit: 'days' },
      enabled: true,
      nextRunAt: NEXT_AT,
      actionType: 'agent',
    },
    {
      id: 'wake',
      name: '主动巡检',
      schedule: { type: 'cron', expression: '0 8 * * *', timezone: 'UTC' },
      enabled: true,
      nextRunAt: NEXT_AT,
      lastRunAt: LAST_AT,
      lastStatus: 'completed',
      actionType: 'role_wake',
    },
  ];
}

let current: RoleBoundCronJob[] = [];

function renderSection(jobs = current) {
  return render(<RoleRoutinesSection roleId={ROLE_ID} jobs={jobs} />);
}

describe('RoleRoutinesSection', () => {
  beforeEach(() => {
    current = sampleJobs();
    invokeDomain.mockImplementation((_domain: string, action: string) => {
      if (action === 'listBoundCronJobs') return Promise.resolve(current.map((job) => ({ ...job })));
      return Promise.resolve(undefined);
    });
    updateJob.mockImplementation(async (id: string, updates: { enabled?: boolean }) => {
      current = current.map((job) => (job.id === id ? { ...job, enabled: updates.enabled ?? job.enabled } : job));
      return { id, enabled: updates.enabled };
    });
    triggerJob.mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders next run and last result for both routines, and keeps the empty state', async () => {
    const { unmount } = renderSection();
    const nextLabel = new Date(NEXT_AT).toLocaleString();
    const lastLabel = new Date(LAST_AT).toLocaleString();
    const failed = screen.getByTestId('role-bound-automation-daily-report');
    const never = screen.getByTestId('role-bound-automation-weekly-report');
    expect(failed.textContent).toContain(`下次运行：${nextLabel}`);
    expect(failed.textContent).toContain(`上次运行：${lastLabel} · 失败 · 站点打不开`);
    expect(failed.textContent).toContain('前往自动化面板');
    expect(never.textContent).toContain('每 1 天');
    expect(never.textContent).toContain(`下次运行：${nextLabel}`);
    expect(never.textContent).toContain('上次运行：还没跑过');
    unmount();

    renderSection([]);
    expect(screen.getByTestId('role-bound-automations-empty').textContent).toContain('这个角色还没有绑定的自动化');
  });

  it('Pause calls updateJob with enabled false and the row flips to Resume', async () => {
    renderSection();
    fireEvent.click(screen.getByTestId('role-bound-automation-toggle-daily-report'));
    await waitFor(() => {
      expect(screen.getByTestId('role-bound-automation-toggle-daily-report').textContent).toContain('恢复');
    });
    expect(updateJob).toHaveBeenCalledWith('daily-report', { enabled: false });
    expect(screen.getByTestId('role-bound-automation-daily-report').textContent).toContain('停用');
    expect(invokeDomain).toHaveBeenCalledWith(expect.anything(), 'listBoundCronJobs', { roleId: ROLE_ID });
  });

  it('Run now calls triggerJob and the button stays disabled while that run is in flight', async () => {
    let release: (value: unknown) => void = () => {};
    triggerJob.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    renderSection();
    fireEvent.click(screen.getByTestId('role-bound-automation-run-weekly-report'));
    await waitFor(() => {
      const button = screen.getByTestId('role-bound-automation-run-weekly-report') as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.textContent).toContain('运行中');
    });
    expect(triggerJob).toHaveBeenCalledWith('weekly-report');
    release(null);
    await waitFor(() => {
      expect((screen.getByTestId('role-bound-automation-run-weekly-report') as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('shows the rejected call as inline error text', async () => {
    updateJob.mockRejectedValue(new Error('调度服务没接上'));
    renderSection();
    fireEvent.click(screen.getByTestId('role-bound-automation-toggle-daily-report'));
    const error = await screen.findByTestId('role-bound-automation-error-daily-report');
    expect(error.textContent).toContain('调度服务没接上');
    expect(screen.getByTestId('role-bound-automation-toggle-daily-report').textContent).toContain('暂停');
  });

  it('labels a webhook event schedule as Webhook', () => {
    renderSection([{
      id: 'hook',
      name: '站点回调',
      schedule: { type: 'event', source: 'webhook', eventName: 'message' },
      enabled: true,
      actionType: 'agent',
    }]);
    const row = screen.getByTestId('role-bound-automation-hook');
    expect(row.textContent).toContain('事件触发 · Webhook');
    expect(row.textContent).not.toContain('undefined');
  });

  it('shows Run now on a role-wake row and does not show Pause', () => {
    renderSection();
    const wake = screen.getByTestId('role-bound-automation-wake');
    expect(screen.getByTestId('role-bound-automation-run-wake').textContent).toContain('现在运行');
    expect(screen.queryByTestId('role-bound-automation-toggle-wake')).toBeNull();
    expect(wake.textContent).toContain('由上方「主动性」设置管理');
    expect(wake.textContent).toContain('完成');
  });
});
