// @vitest-environment jsdom
// N-CRON-RUN-COMPLETED-BUT-DENIED ④：被拒且无产出的完成运行在运行列表/详情/待过目
// 收件箱显示琥珀色「需处理」（不是绿色「成功」）；详情有一句话原因 + 立即重跑
// （接 triggerJob）；没有标记的旧执行记录仍显示「成功」。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionAutomationRecord } from '../../../src/shared/contract/sessionAutomation';
import type { CronJobExecution } from '../../../src/shared/contract/cron';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: vi.fn(), invokeDomain: vi.fn() },
}));
vi.mock('../../../src/renderer/services/cronClient', () => {
  const mocked = {
    listJobs: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue(null),
    getExecutions: vi.fn().mockResolvedValue([]),
    getRecentExecutions: vi.fn().mockResolvedValue([]),
    triggerJob: vi.fn(),
    grantLoginPassThrough: vi.fn().mockResolvedValue(null),
  };
  return { cronClient: mocked, default: mocked };
});
const listPendingReview = vi.fn<() => Promise<SessionAutomationRecord[]>>();
const listParkedApprovals = vi.fn().mockResolvedValue([]);
const countPendingReview = vi.fn().mockResolvedValue(undefined);
const markReviewed = vi.fn().mockResolvedValue(null);
const switchSession = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../src/renderer/services/sessionAutomationClient', () => ({
  sessionAutomationClient: {
    listPendingReview: () => listPendingReview(),
    listParkedApprovals: () => listParkedApprovals(),
    countPendingReview: () => countPendingReview(),
    markReviewed: (id: string) => markReviewed(id),
    listAwaitingApprovalRuns: () => Promise.resolve([]),
  },
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: { switchSession: typeof switchSession }) => unknown) =>
    selector({ switchSession }),
}));

import { CronExecutionList } from '../../../src/renderer/components/features/cron/CronExecutionList';
import { CronExecutionDetail } from '../../../src/renderer/components/features/cron/CronExecutionDetail';
import { AutomationReviewInbox } from '../../../src/renderer/components/features/cron/AutomationReviewInbox';

const NOW = new Date(2026, 10, 3, 9, 0).getTime();
const originalTriggerJob = useCronStore.getState().triggerJob;

const DENIED_MARKER = {
  count: 1,
  steps: [{ tool: 'bash', summary: 'echo hello > out.txt', reason: 'timeout' as const }],
};

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

function makeRecord(over: Partial<SessionAutomationRecord>): SessionAutomationRecord {
  return {
    id: 'auto-1',
    sourceSessionId: 'src-1',
    type: 'cron',
    status: 'active',
    title: '清理任务',
    config: { pendingReview: { resultSessionId: 'result-1', at: NOW } },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

afterEach(() => {
  cleanup();
  useCronStore.setState({ triggerJob: originalTriggerJob });
  listPendingReview.mockReset();
  listPendingReview.mockResolvedValue([]);
});

describe('CronExecutionList 需处理徽章', () => {
  it('被拒且无产出的完成行显示琥珀「需处理」，不显示「成功」', () => {
    render(
      <CronExecutionList
        executions={[
          execution({ id: 'denied', result: { sessionId: 's', permissionDenied: DENIED_MARKER } }),
          execution({ id: 'legacy', result: { sessionId: 's' } }),
        ]}
        selectedExecutionId={null}
        onSelectExecution={() => undefined}
      />,
    );
    const badge = screen.getByTestId('cron-execution-permission-denied');
    expect(badge.textContent).toBe('需处理');
    expect(badge.className).toContain('text-badge-warning');
    // 旧行（同表）仍显示「成功」
    expect(screen.getByText('完成')).toBeTruthy();
    expect(screen.queryAllByTestId('cron-execution-permission-denied')).toHaveLength(1);
  });

  it('旧执行记录（无字段）不产生需处理徽章', () => {
    render(
      <CronExecutionList
        executions={[execution({ result: undefined })]}
        selectedExecutionId={null}
        onSelectExecution={() => undefined}
      />,
    );
    expect(screen.queryByTestId('cron-execution-permission-denied')).toBeNull();
    expect(screen.getByText('完成')).toBeTruthy();
  });
});

describe('CronExecutionDetail 需处理徽章与重跑', () => {
  it('状态 chip 换「需处理」，一句话点名命令与原因，附重跑按钮（接 triggerJob）', async () => {
    const triggerJob = vi.fn().mockResolvedValue(null);
    useCronStore.setState({ triggerJob });
    render(
      <CronExecutionDetail
        execution={execution({ result: { sessionId: 's', permissionDenied: DENIED_MARKER } })}
      />,
    );
    const chip = screen.getByTestId('cron-exec-detail-permission-denied');
    expect(chip.textContent).toBe('需处理');
    expect(chip.className).toContain('text-badge-warning');
    expect(screen.queryByText('完成')).toBeNull();
    expect(screen.getByTestId('cron-permission-denied-sentence').textContent)
      .toBe('「echo hello > out.txt」没有获批准（等批准超时，没有人处理），这次运行没有产出。');
    expect(screen.getByText('重新运行会再次请求批准')).toBeTruthy();
    fireEvent.click(screen.getByTestId('cron-permission-denied-rerun'));
    await waitFor(() => {
      expect(triggerJob).toHaveBeenCalledWith('job-1');
    });
  });

  it('各 reason 的一句话映射（user / cancelled / other）', () => {
    const reasons = [
      ['user', '你当时拒绝了它'],
      ['cancelled', '运行被取消或重启，批准被作废'],
      ['other', '审批链路出问题，按安全默认拒绝了'],
    ] as const;
    for (const [reason, sentence] of reasons) {
      const { unmount } = render(
        <CronExecutionDetail
          execution={execution({
            id: `exec-${reason}`,
            result: { sessionId: 's', permissionDenied: { count: 1, steps: [{ tool: 'bash', summary: 'rm -rf build', reason }] } },
          })}
        />,
      );
      expect(screen.getByTestId('cron-permission-denied-sentence').textContent)
        .toBe(`「rm -rf build」没有获批准（${sentence}），这次运行没有产出。`);
      unmount();
    }
  });

  it('旧执行记录（无标记）仍是绿色「成功」且不渲染需处理区', () => {
    render(<CronExecutionDetail execution={execution({ result: { sessionId: 's' } })} />);
    expect(screen.getByText('完成')).toBeTruthy();
    expect(screen.queryByTestId('cron-permission-denied-detail')).toBeNull();
    expect(screen.queryByTestId('cron-exec-detail-permission-denied')).toBeNull();
  });
});

describe('AutomationReviewInbox 需处理徽章', () => {
  it('待过目记录带 permissionDenied → 琥珀「需处理」徽章；不带则无', async () => {
    listPendingReview.mockResolvedValue([
      makeRecord({ config: { pendingReview: { resultSessionId: 'result-1', at: NOW, permissionDenied: DENIED_MARKER } } }),
      makeRecord({ id: 'auto-2', config: { pendingReview: { resultSessionId: 'result-2', at: NOW } } }),
    ]);
    render(<AutomationReviewInbox />);
    await waitFor(() => {
      expect(screen.getAllByTestId('automation-review-item')).toHaveLength(2);
    });
    const badges = screen.getAllByTestId('automation-review-permission-denied');
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toBe('需处理');
  });
});
