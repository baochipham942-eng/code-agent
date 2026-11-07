// @vitest-environment jsdom
// ============================================================================
// CronJobDetailExecutionOrder.test.tsx — N-FIX-FIX-NOTIFY-NEEDS-INPUT-FOREGROUND-BANNER-FU1-RUNSTATE
//
// FB-591 组件级钉住：host 对 25 行执行记录返回旧→新升序窗口（最旧 interrupted、
// 最新 completed）时，真实 CronJobDetail + 真实 cronStore 必须在详情头显示
// 「最近: 完成」（不是旧运行的「已中断」），且历史表第一行是最新的那次运行。
// 只打桩 cronClient（host 边界），store 走真 loadExecutions 归一。
// ============================================================================
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition, CronJobExecution } from '../../../src/shared/contract';

vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    listJobs: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue(null),
    getExecutions: vi.fn().mockResolvedValue([]),
    getRecentExecutions: vi.fn().mockResolvedValue([]),
  },
}));

import { CronJobDetail } from '../../../src/renderer/components/features/cron/CronJobDetail';
import { cronClient } from '../../../src/renderer/services/cronClient';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

function makeJob(): CronJobDefinition {
  return {
    id: 'job-1',
    runsOn: 'local',
    name: '每日晨报',
    scheduleType: 'cron',
    schedule: { type: 'cron', expression: '30 8 * * *' },
    action: { type: 'agent', agentType: 'general', prompt: '每天整理晨报' },
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** host 形状：25 行旧→新升序，最旧 interrupted，最新 completed。 */
function ascendingHostWindow(): CronJobExecution[] {
  const base = new Date(2026, 0, 1, 8, 0, 0).getTime();
  return Array.from({ length: 25 }, (_, i) => {
    const scheduledAt = base + i * 86_400_000;
    const status = i === 0 ? 'interrupted' : 'completed';
    return {
      id: `exec-${i + 1}`,
      jobId: 'job-1',
      status,
      scheduledAt,
      startedAt: scheduledAt + 1_000,
      ...(status === 'completed'
        ? { completedAt: scheduledAt + 61_000, duration: 60_000 }
        : {}),
      retryAttempt: 0,
    };
  });
}

beforeEach(() => {
  vi.mocked(cronClient.getExecutions).mockImplementation(async () => ascendingHostWindow() as never);
  useCronStore.setState({
    jobs: [], stats: null, latestExecutions: {}, executionsByJobId: {}, selectedJobId: null,
    filterMode: 'all', searchQuery: '', isLoading: false, isEditorOpen: false,
    editingJobId: null, copyingJobId: null, error: null, recentExecutions: [],
  });
});

afterEach(() => {
  cleanup();
});

describe('CronJobDetail 执行历史顺序（FB-591）', () => {
  it('长历史任务详情头「最近」显示最新一次完成，历史表第一行是最新的运行', async () => {
    render(<CronJobDetail job={makeJob()} />);

    // 详情头 chip：最新一次是 completed（旧实现会显示最旧一行的「已中断」）
    expect(await screen.findByText('最近: 完成')).toBeTruthy();
    expect(screen.queryByText('最近: 已中断')).toBeNull();

    // 历史表：第一行 = 最新一次（2026/01/25 08:00 完成），末行 = 最旧（01/01 08:00 已中断）
    const rows = screen.getByTestId('cron-execution-table-scroll').querySelectorAll('tbody tr');
    expect(rows).toHaveLength(25);
    expect(rows[0].textContent).toContain('01/25 08:00');
    expect(rows[0].textContent).toContain('完成');
    expect(rows[rows.length - 1].textContent).toContain('01/01 08:00');
    expect(rows[rows.length - 1].textContent).toContain('已中断');
  });
});
