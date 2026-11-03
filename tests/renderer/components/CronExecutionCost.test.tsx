// @vitest-environment jsdom
// N-CRON-RUN-LEDGER-VISIBLE：运行记录的成本可见性——
// 1) 执行列表有「成本」列（有读数显示美元、无读数 dash）；
// 2) 跳过的唤醒（silent 档 / 日预算满 / 免打扰）在行内显示未运行原因；
// 3) 执行详情显示成本与未运行原因。
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: vi.fn() },
}));
vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    listJobs: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue(null),
    getExecutions: vi.fn().mockResolvedValue([]),
    getRecentExecutions: vi.fn().mockResolvedValue([]),
    triggerJob: vi.fn(),
  },
}));
import type { CronJobExecution } from '@shared/contract';
import { CronExecutionList } from '../../../src/renderer/components/features/cron/CronExecutionList';
import { CronExecutionDetail } from '../../../src/renderer/components/features/cron/CronExecutionDetail';

const NOW = new Date(2026, 9, 26, 9, 0).getTime();

function execution(overrides: Partial<CronJobExecution> = {}): CronJobExecution {
  return {
    id: 'exec-1',
    jobId: 'job-1',
    runsOn: 'local',
    status: 'completed',
    scheduledAt: NOW,
    startedAt: NOW,
    completedAt: NOW + 1_500,
    duration: 1_500,
    retryAttempt: 0,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('CronExecutionList 成本列', () => {
  it('有读数显示美元（4 位小数），无读数 dash', () => {
    render(
      <CronExecutionList
        executions={[execution({ id: 'a', cost: 0.0123 }), execution({ id: 'b', cost: undefined })]}
        selectedExecutionId={null}
        onSelectExecution={() => undefined}
      />,
    );
    const cells = screen.getAllByTestId('cron-execution-cost-cell');
    expect(cells[0].textContent).toBe('$0.0123');
    expect(cells[1].textContent).toBe('—');
    expect(screen.getByText('成本')).toBeTruthy();
  });

  it('跳过的唤醒行显示三种未运行原因', () => {
    render(
      <CronExecutionList
        executions={[
          execution({ id: 's1', result: { roleId: 'r', trigger: 'cadence', status: 'skipped', skipReason: 'silent_level' } }),
          execution({ id: 's2', result: { roleId: 'r', trigger: 'cadence', status: 'skipped', skipReason: 'daily_budget_exceeded (3/3)' } }),
          execution({ id: 's3', result: { roleId: 'r', trigger: 'cadence', status: 'skipped', skipReason: 'quiet_hours' } }),
        ]}
        selectedExecutionId={null}
        onSelectExecution={() => undefined}
      />,
    );
    const reasonNodes = screen.getAllByTestId('cron-wake-skip-reason');
    const reasons = reasonNodes.map((node) => node.textContent);
    expect(reasons[0]).toBe('未运行：角色处于静默档，不主动醒来');
    expect(reasons[1]).toBe('未运行：今日唤醒次数已用满（3/3）');
    expect(reasons[2]).toBe('未运行：处于免打扰时段，本次不补');
    for (const node of reasonNodes) {
      const cell = node.closest('td');
      expect(cell?.getAttribute('colspan')).toBe('7');
      expect(cell?.querySelector('span')).toBeNull();
    }
    expect(document.querySelector('[data-testid="cron-execution-table-scroll"]')?.className).toContain('overflow-x-auto');
  });

  // N-CRON-RUN-LEDGER-VISIBLE-FU2-AFTERP2 ①：单任务视图（runsOn → 8 列）与
  // 跨任务视图（jobName+runsOn → 9 列）下，未运行原因整行横跨、不裁切、是行的唯一单元格。
  const SKIP_EXEC = (id: string, skipReason: string) => execution({
    id, result: { roleId: 'r', trigger: 'cadence', status: 'skipped', skipReason },
  });
  const SKIP_REASONS = ['silent_level', 'daily_budget_exceeded (3/3)', 'quiet_hours'];

  const assertSkipRows = (expectedColumns: number) => {
    const reasonNodes = screen.getAllByTestId('cron-wake-skip-reason');
    expect(reasonNodes).toHaveLength(SKIP_REASONS.length);
    const thCount = document.querySelectorAll('thead th').length;
    expect(thCount).toBe(expectedColumns);
    for (const node of reasonNodes) {
      const cell = node.closest('td');
      expect(cell?.getAttribute('colspan')).toBe(String(expectedColumns));
      expect(cell?.getAttribute('colspan')).toBe(String(thCount));
      expect(cell?.querySelector('span')).toBeNull();
      const cls = cell?.className ?? '';
      expect(cls).not.toMatch(/truncate|max-w-|overflow-hidden|whitespace-nowrap/);
      const row = cell?.closest('tr');
      expect(row?.querySelectorAll(':scope > td').length).toBe(1);
      expect(row?.querySelectorAll('td').length).toBe(1);
    }
    return reasonNodes.map((node) => node.textContent);
  };

  it('单任务视图（8 列）：三原因+正常行，skip 格横跨全表头且不裁切', () => {
    render(
      <CronExecutionList
        executions={[
          execution({ id: 'ok-8' }),
          SKIP_EXEC('s1', SKIP_REASONS[0]),
          SKIP_EXEC('s2', SKIP_REASONS[1]),
          SKIP_EXEC('s3', SKIP_REASONS[2]),
        ]}
        selectedExecutionId={null}
        onSelectExecution={() => undefined}
        runsOnByJobId={{ 'job-1': 'local' }}
      />,
    );
    const reasons = assertSkipRows(8);
    expect(reasons[0]).toBe('未运行：角色处于静默档，不主动醒来');
    expect(reasons[1]).toBe('未运行：今日唤醒次数已用满（3/3）');
    expect(reasons[2]).toBe('未运行：处于免打扰时段，本次不补');
    // 正常行（无 skip）不产生原因行；正常行自身 8 个 td
    const normalRow = screen.getAllByText('完成')[0].closest('tr');
    expect(normalRow?.querySelectorAll('td').length).toBe(8);
  });

  it('跨任务视图（9 列）：三原因+正常行，skip 格横跨全表头且不裁切', () => {
    render(
      <CronExecutionList
        executions={[
          execution({ id: 'ok-9', jobId: 'job-1' }),
          SKIP_EXEC('s1', SKIP_REASONS[0]),
          SKIP_EXEC('s2', SKIP_REASONS[1]),
          SKIP_EXEC('s3', SKIP_REASONS[2]),
        ]}
        selectedExecutionId={null}
        onSelectExecution={() => undefined}
        jobNameById={{ 'job-1': '任务甲' }}
        runsOnByJobId={{ 'job-1': 'local' }}
      />,
    );
    const reasons = assertSkipRows(9);
    expect(reasons[0]).toBe('未运行：角色处于静默档，不主动醒来');
    expect(reasons[1]).toBe('未运行：今日唤醒次数已用满（3/3）');
    expect(reasons[2]).toBe('未运行：处于免打扰时段，本次不补');
    const normalRow = screen.getAllByText('任务甲')[0].closest('tr');
    expect(normalRow?.querySelectorAll('td').length).toBe(9);
  });

  it('云端运行即使带数字也显示 dash', () => {
    render(
      <CronExecutionList
        executions={[execution({ id: 'cloud', cost: 9, runsOn: 'cloud' })]}
        selectedExecutionId={null}
        onSelectExecution={() => undefined}
      />,
    );
    expect(screen.getByTestId('cron-execution-cost-cell').textContent).toBe('—');
  });

  it('正常完成（含空产物安静醒来）不显示未运行原因', () => {
    render(
      <CronExecutionList
        executions={[execution({ id: 'ok', result: { roleId: 'r', trigger: 'cadence', status: 'completed', decision: 'silence' } })]}
        selectedExecutionId={null}
        onSelectExecution={() => undefined}
      />,
    );
    expect(screen.queryByTestId('cron-wake-skip-reason')).toBeNull();
  });
});

describe('CronExecutionDetail 成本与未运行原因', () => {
  it('显示成本读数（4 位小数）', () => {
    render(<CronExecutionDetail execution={execution({ cost: 0.5 })} />);
    expect(screen.getByTestId('cron-execution-cost').textContent).toBe('成本$0.5000');
  });

  it('无模型调用显示 dash', () => {
    render(<CronExecutionDetail execution={execution({ cost: undefined })} />);
    expect(screen.getByTestId('cron-execution-cost').textContent).toBe('成本—');
  });

  it('云端运行显示 dash', () => {
    render(<CronExecutionDetail execution={execution({ cost: 9, runsOn: 'cloud' })} />);
    expect(screen.getByTestId('cron-execution-cost').textContent).toBe('成本—');
  });

  it('跳过的唤醒显示未运行原因区', () => {
    render(
      <CronExecutionDetail
        execution={execution({ result: { roleId: 'r', trigger: 'cadence', status: 'skipped', skipReason: 'quiet_hours' } })}
      />,
    );
    expect(screen.getByTestId('cron-wake-skip-sentence').textContent).toBe('未运行：处于免打扰时段，本次不补');
    expect(screen.getByTestId('cron-wake-skip-detail')).toBeTruthy();
  });

  it('正常完成不渲染未运行原因区', () => {
    render(<CronExecutionDetail execution={execution()} />);
    expect(screen.queryByTestId('cron-wake-skip-detail')).toBeNull();
  });
});
