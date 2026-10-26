// @vitest-environment jsdom
// N-CRON-RUN-LEDGER-VISIBLE：角色页「最近唤醒」——
// 1) 只聚合该角色 role-wake 任务的执行记录（其他角色/agent 任务不进来）；
// 2) 行内显示成本或未运行原因；
// 3) 每日小计与自动化中心共用 CronDailyCostSummary（同一纯函数口径）。
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const { listJobs, getExecutions } = vi.hoisted(() => ({
  listJobs: vi.fn(),
  getExecutions: vi.fn(),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: vi.fn() },
}));
vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: { listJobs, getExecutions },
}));
import type { CronJobDefinition, CronJobExecution } from '@shared/contract';
import { RoleWakeLedger } from '../../../src/renderer/components/features/expert/RoleWakeLedger';

const todayAtNine = new Date();
todayAtNine.setHours(9, 0, 0, 0);
const NOW = todayAtNine.getTime();
const yesterdayAtNine = new Date(todayAtNine);
yesterdayAtNine.setDate(yesterdayAtNine.getDate() - 1);
const YESTERDAY = yesterdayAtNine.getTime();

function job(id: string, action: CronJobDefinition['action']): CronJobDefinition {
  return {
    id,
    name: id,
    scheduleType: 'every',
    schedule: { type: 'every', interval: 1, unit: 'hours' },
    action,
    runsOn: 'local',
    enabled: true,
    maxRetries: 0,
    timeout: 60_000,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function wakeExecution(id: string, overrides: Partial<CronJobExecution> = {}): CronJobExecution {
  return {
    id,
    jobId: 'wake-a',
    runsOn: 'local',
    status: 'completed',
    scheduledAt: NOW,
    startedAt: NOW,
    duration: 2_000,
    retryAttempt: 0,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RoleWakeLedger', () => {
  it('只聚合该角色 role-wake 任务的执行记录，行内显示成本与未运行原因', async () => {
    listJobs.mockResolvedValue([
      job('wake-a', { type: 'role-wake', roleId: 'role-a' }),
      job('wake-b', { type: 'role-wake', roleId: 'role-b' }),
      job('agent-a', { type: 'agent', agentType: 'default', prompt: 'p' }),
    ]);
    getExecutions.mockImplementation((jobId: string) =>
      Promise.resolve(
        jobId === 'wake-a'
          ? [
              wakeExecution('w1', { cost: 0.03 }),
              wakeExecution('w2', {
                result: { roleId: 'role-a', trigger: 'cadence', status: 'skipped', skipReason: 'daily_budget_exceeded (3/3)' },
              }),
              wakeExecution('w4', {
                result: { roleId: 'role-a', trigger: 'cadence', status: 'skipped', skipReason: 'silent_level' },
              }),
              wakeExecution('w5', {
                result: { roleId: 'role-a', trigger: 'cadence', status: 'skipped', skipReason: 'quiet_hours' },
              }),
              wakeExecution('w3', { scheduledAt: YESTERDAY, startedAt: YESTERDAY, cost: 0.11 }),
            ]
          : [wakeExecution('foreign')],
      ),
    );
    render(<RoleWakeLedger roleId="role-a" />);
    await waitFor(() => {
      expect(screen.getByTestId('role-wake-ledger-list')).toBeTruthy();
    });
    expect(getExecutions).toHaveBeenCalledTimes(1);
    expect(getExecutions).toHaveBeenCalledWith('wake-a', 20);
    const values = screen.getAllByTestId('role-wake-ledger-value').map((node) => node.textContent);
    expect(values).toContain('$0.0300');
    expect(values).toContain('未运行：今日唤醒次数已用满（3/3）');
    expect(values).toContain('未运行：角色处于静默档，不主动醒来');
    expect(values).toContain('未运行：处于免打扰时段，本次不补');
    expect(values).toContain('$0.1100');
  });

  it('每日小计出现在角色页（与自动化中心同组件同口径）', async () => {
    listJobs.mockResolvedValue([job('wake-a', { type: 'role-wake', roleId: 'role-a' })]);
    getExecutions.mockResolvedValue([
      wakeExecution('w1', { cost: 0.03 }),
      wakeExecution('w2', {
        result: { roleId: 'role-a', trigger: 'cadence', status: 'skipped', skipReason: 'quiet_hours' },
      }),
      wakeExecution('w3', { scheduledAt: YESTERDAY, startedAt: YESTERDAY, cost: 0.11 }),
    ]);
    render(<RoleWakeLedger roleId="role-a" />);
    await waitFor(() => {
      expect(screen.getByTestId('role-wake-daily-cost')).toBeTruthy();
    });
    const summaryText = screen.getByTestId('role-wake-daily-cost').textContent ?? '';
    expect(summaryText).toContain('今天');
    expect(summaryText).toContain('$0.0300');
    expect(summaryText).toContain('昨天');
    expect(summaryText).toContain('$0.1100');
    expect(summaryText).toContain('跳过 1 次');
  });

  it('没有唤醒记录时显示空态', async () => {
    listJobs.mockResolvedValue([]);
    render(<RoleWakeLedger roleId="role-a" />);
    await waitFor(() => {
      expect(screen.getByTestId('role-wake-ledger-empty')).toBeTruthy();
    });
  });
});
