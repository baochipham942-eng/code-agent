// @vitest-environment jsdom
// N-UI-CRON-RUN-RECORD-CLEAR-FU1：专家页绑定自动化的「上次运行」行与运行记录状态行同一口径
// （cronRunRecord.*），失败只给人话（没跑成 / 没跑成：命令被拒绝），host 原始执行错误
// （如 ECONNRESET socket hang up）绝不出现；取消、中断、完成也逐状态钉死，zh/en 双语。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoleBoundCronJob } from '../../../src/shared/contract/roleAssets';
import { useAppStore } from '../../../src/renderer/stores/appStore';

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

// 中文界面时间口径（N-CRON-DETAIL-TIME-FORMAT-MIXED）：24 小时制 YYYY/MM/DD HH:mm，
// 从 Date 分量手工推导，任何机器 locale / 时区下都与组件输出一致。
function zhDetailTime(ms: number): string {
  const d = new Date(ms);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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
      lastError: 'ECONNRESET socket hang up',
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
  useAppStore.setState({ language: 'zh' });
});

/** 单行夹具：只换上次运行的状态/错误，其余字段同晨报行。 */
function lastRunJob(overrides: Partial<RoleBoundCronJob>): RoleBoundCronJob[] {
  return [{
    id: 'daily-report',
    name: '晨报',
    schedule: { type: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
    enabled: true,
    nextRunAt: NEXT_AT,
    lastRunAt: LAST_AT,
    actionType: 'agent',
    ...overrides,
  }];
}

function expectLastLine(needle: string): string {
  const line = screen.getByTestId('role-bound-automation-last-daily-report');
  expect(line.textContent).toContain(needle);
  return line.textContent ?? '';
}

describe('RoleRoutinesSection', () => {
  it('renders next run and last result for both routines, and keeps the empty state', async () => {
    const { unmount } = renderSection();
    const nextLabel = zhDetailTime(NEXT_AT);
    const lastLabel = zhDetailTime(LAST_AT);
    const failed = screen.getByTestId('role-bound-automation-daily-report');
    const never = screen.getByTestId('role-bound-automation-weekly-report');
    expect(failed.textContent).toContain(`下次运行：${nextLabel}`);
    // 普通失败 = 「没跑成」（运行记录同一口径）；喂进去的 ECONNRESET 原文绝不回显。
    expect(failed.textContent).toContain(`上次运行：${lastLabel} · 没跑成`);
    expect(failed.textContent).not.toContain('ECONNRESET');
    expect(failed.textContent).not.toContain('socket hang up');
    expect(failed.textContent).not.toContain('命令被拒绝');
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

describe('RoleRoutinesSection 上次运行口径与运行记录一致（zh，N-UI-CRON-RUN-RECORD-CLEAR-FU1）', () => {
  const lastLabel = zhDetailTime(LAST_AT);

  beforeEach(() => {
    useAppStore.setState({ language: 'zh' });
  });

  it('权限被拒的失败显示「没跑成：命令被拒绝」，不带 host 错误原文', () => {
    renderSection(lastRunJob({ lastStatus: 'failed', lastError: 'PERMISSION_DENIED: user denied' }));
    const line = expectLastLine(`上次运行：${lastLabel} · 没跑成：命令被拒绝`);
    expect(line).not.toContain('PERMISSION_DENIED');
    expect(line).not.toContain('user denied');
  });

  it('普通失败显示「没跑成」，喂 ECONNRESET socket hang up 也不回显原文', () => {
    renderSection(lastRunJob({ lastStatus: 'failed', lastError: 'ECONNRESET socket hang up' }));
    const line = expectLastLine(`上次运行：${lastLabel} · 没跑成`);
    expect(line).not.toContain('ECONNRESET');
    expect(line).not.toContain('socket hang up');
    expect(line).not.toContain('命令被拒绝');
  });

  it('取消显示「已取消」', () => {
    renderSection(lastRunJob({ lastStatus: 'cancelled' }));
    expectLastLine(`上次运行：${lastLabel} · 已取消`);
  });

  it('中断显示「已中断，没有结果」', () => {
    renderSection(lastRunJob({ lastStatus: 'interrupted' }));
    expectLastLine(`上次运行：${lastLabel} · 已中断，没有结果`);
  });

  it('完成维持原状「完成」', () => {
    renderSection(lastRunJob({ lastStatus: 'completed' }));
    expectLastLine(`上次运行：${lastLabel} · 完成`);
  });
});

describe('RoleRoutinesSection last-run wording matches the run record (en, N-UI-CRON-RUN-RECORD-CLEAR-FU1)', () => {
  beforeEach(() => {
    useAppStore.setState({ language: 'en' });
  });

  it('denied failure says "Didn\'t run: command was denied", never the raw error', () => {
    renderSection(lastRunJob({ lastStatus: 'failed', lastError: 'PERMISSION_DENIED: user denied' }));
    const line = expectLastLine("· Didn't run: command was denied");
    expect(line).not.toContain('PERMISSION_DENIED');
    expect(line).not.toContain('user denied');
    expect(line).toContain('Last run:');
  });

  it('generic failure says "Didn\'t finish" and never echoes ECONNRESET socket hang up', () => {
    renderSection(lastRunJob({ lastStatus: 'failed', lastError: 'ECONNRESET socket hang up' }));
    const line = expectLastLine("· Didn't finish");
    expect(line).not.toContain('ECONNRESET');
    expect(line).not.toContain('socket hang up');
    expect(line).not.toContain("command was denied");
  });

  it('cancelled says "Cancelled"', () => {
    renderSection(lastRunJob({ lastStatus: 'cancelled' }));
    expectLastLine('· Cancelled');
  });

  it('interrupted says "Interrupted — no result"', () => {
    renderSection(lastRunJob({ lastStatus: 'interrupted' }));
    expectLastLine('· Interrupted — no result');
  });

  it('completed keeps the previous wording "Done"', () => {
    renderSection(lastRunJob({ lastStatus: 'completed' }));
    expectLastLine('· Done');
  });
});
