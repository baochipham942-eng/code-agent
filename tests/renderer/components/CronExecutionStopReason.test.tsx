// @vitest-environment jsdom
// N-FIX-PARKED-APPROVAL-SURVIVE-RESTART-REALRUN-FU2 ②：运行详情给 interrupted/failed 的 run 显示「为什么停了」，
// 句子逐字来自 host（与收件箱同一句）。
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const invokeDomain = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: { invokeDomain } }));
vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: { listJobs: vi.fn(), getStats: vi.fn(), getExecutions: vi.fn(), getRecentExecutions: vi.fn(), triggerJob: vi.fn() },
}));
const language = vi.hoisted(() => ({ value: 'zh' as 'zh' | 'en' }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { cronCenterZh, cronCenterEn } = await import('../../../src/renderer/i18n/cronCenter');
  return {
    useI18n: () => ({
      language: language.value,
      t: language.value === 'zh' ? cronCenterZh : cronCenterEn,
    }),
  };
});

import type { CronJobExecution } from '@shared/contract';
import { CronExecutionDetail } from '../../../src/renderer/components/features/cron/CronExecutionDetail';
import { describeParkedApprovalClosure } from '../../../src/host/agent/parkedApprovalSurvival';

const SENTENCE = describeParkedApprovalClosure('expired_after_restart_24h');
const execution = (o: Partial<CronJobExecution> = {}): CronJobExecution => ({
  id: 'exec-1', jobId: 'job-1', runsOn: 'local', status: 'interrupted', scheduledAt: 1, retryAttempt: 0,
  sessionId: 'sess-1', ...o,
});

afterEach(() => { cleanup(); invokeDomain.mockReset(); language.value = 'zh'; });

describe('CronExecutionDetail 为什么停了', () => {
  it('② interrupted + 有作废审批：显示标签与 host 句子（zh）', async () => {
    invokeDomain.mockResolvedValue(SENTENCE);
    const { container } = render(<CronExecutionDetail execution={execution()} />);
    await waitFor(() => expect(screen.getByTestId('cron-exec-stop-reason')).toBeTruthy());
    expect(invokeDomain).toHaveBeenCalledWith('domain:sessionAutomation', 'getVoidedApprovalReason', { sessionId: 'sess-1' });
    console.log(`[DOM zh] ${screen.getByTestId('cron-exec-stop-reason').textContent}`);
    expect(screen.getByTestId('cron-exec-stop-reason').textContent).toBe(`为什么停了${SENTENCE}`);
    expect(container.textContent).toContain('这一步等你确认超过 24 小时，已自动作废，没有执行。');
  });

  it('② en 标签 Why it stopped；failed 状态同样查询', async () => {
    language.value = 'en';
    invokeDomain.mockResolvedValue(SENTENCE);
    render(<CronExecutionDetail execution={execution({ status: 'failed' })} />);
    await waitFor(() => expect(screen.getByTestId('cron-exec-stop-reason')).toBeTruthy());
    console.log(`[DOM en] ${screen.getByTestId('cron-exec-stop-reason').textContent}`);
    expect(screen.getByTestId('cron-exec-stop-reason').textContent).toBe(`Why it stopped${SENTENCE}`);
  });

  it('无原因 / completed / 无 sessionId：不渲染也不查询；查询报错不崩', async () => {
    invokeDomain.mockResolvedValue(null);
    const { rerender } = render(<CronExecutionDetail execution={execution()} />);
    await waitFor(() => expect(invokeDomain).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('cron-exec-stop-reason')).toBeNull();
    rerender(<CronExecutionDetail execution={execution({ status: 'completed' })} />);
    rerender(<CronExecutionDetail execution={execution({ sessionId: undefined })} />);
    expect(invokeDomain).toHaveBeenCalledTimes(1);
    invokeDomain.mockRejectedValue(new Error('boom'));
    rerender(<CronExecutionDetail execution={execution({ sessionId: 'sess-2' })} />);
    await waitFor(() => expect(invokeDomain).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('cron-exec-stop-reason')).toBeNull();
  });
});
