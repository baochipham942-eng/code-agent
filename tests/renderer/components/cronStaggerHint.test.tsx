// @vitest-environment jsdom
// ============================================================================
// CronJobEditor 错峰建议（N-CRON-RESILIENCE ②）：撞整点的 cron 表达式给建议，
// every 小时/天级任务提示自动错峰。effect 填充 draft 需要 RTL render（静态渲染不跑 effect）。
// ============================================================================
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract';

vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({
  useMcpServerStates: () => [],
}));

import { CronJobEditor } from '../../../src/renderer/components/features/cron/CronJobEditor';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

beforeEach(() => {
  useCronStore.setState({
    jobs: [],
    stats: null,
    latestExecutions: {},
    executionsByJobId: {},
    selectedJobId: null,
    isLoading: false,
    isEditorOpen: false,
    editingJobId: null,
    error: null,
    createJob: vi.fn(),
    updateJob: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function cronExpressionJob(expression: string): CronJobDefinition {
  return {
    id: 'job-expr',
    runsOn: 'local',
    name: '表达式任务',
    scheduleType: 'cron',
    schedule: { type: 'cron', expression },
    action: { type: 'shell', command: 'echo ok' },
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

function everyJob(unit: 'hours' | 'days' | 'minutes'): CronJobDefinition {
  return {
    id: 'job-every',
    runsOn: 'local',
    name: '间隔任务',
    scheduleType: 'every',
    schedule: { type: 'every', interval: 2, unit },
    action: { type: 'shell', command: 'echo ok' },
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('CronJobEditor 错峰建议', () => {
  it('分钟位为 0 的表达式（0 9 * * *）显示错峰建议', async () => {
    render(<CronJobEditor isOpen job={cronExpressionJob('0 9 * * *')} onClose={() => undefined} />);
    await waitFor(() => {
      expect(screen.getByDisplayValue('0 9 * * *')).toBeTruthy();
    });
    const hint = screen.getByTestId('cron-stagger-hint');
    expect(hint.textContent).toContain('整点任务容易和其他任务扎堆触发');
    expect(hint.textContent).toMatch(/错开到\s*[1-9]\d*\s*分/);
  });

  it('非整点表达式（17 9 * * *）不显示建议', async () => {
    render(<CronJobEditor isOpen job={cronExpressionJob('17 9 * * *')} onClose={() => undefined} />);
    await waitFor(() => {
      expect(screen.getByDisplayValue('17 9 * * *')).toBeTruthy();
    });
    expect(screen.queryByTestId('cron-stagger-hint')).toBeNull();
  });

  it('every 小时/天级任务提示自动错峰；分钟级不提示', async () => {
    const { unmount } = render(<CronJobEditor isOpen job={everyJob('hours')} onClose={() => undefined} />);
    await waitFor(() => {
      expect(screen.getByTestId('cron-auto-stagger-hint').textContent).toContain('自动错峰');
    });
    unmount();

    render(<CronJobEditor isOpen job={everyJob('days')} onClose={() => undefined} />);
    await waitFor(() => {
      expect(screen.getByTestId('cron-auto-stagger-hint').textContent).toContain('自动错峰');
    });
    cleanup();

    render(<CronJobEditor isOpen job={everyJob('minutes')} onClose={() => undefined} />);
    await waitFor(() => {
      expect(screen.getByText('间隔值')).toBeTruthy();
    });
    expect(screen.queryByTestId('cron-auto-stagger-hint')).toBeNull();
  });
});
