// @vitest-environment jsdom
// ============================================================================
// N-TRIGGER-OBSERVE-MODE ④：自动化详情显示执行方式徽标 + 逐事件决策记录（本会执行高亮）；
// 「切换为自动执行」必须过确认弹窗，确认后才调 host 的 setEventActionMode（host 写变更事件）。
// ============================================================================
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronEventDecision, CronJobDefinition } from '../../../src/shared/contract/cron';

const clientState = vi.hoisted(() => ({
  getEventDecisions: vi.fn(),
  setEventActionMode: vi.fn(),
}));

vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    getGroupListenCheck: vi.fn().mockResolvedValue({ status: 'idle' }),
    startGroupListenCheck: vi.fn(),
    listJobs: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue(null),
    getExecutions: vi.fn().mockResolvedValue([]),
    getEventDecisions: clientState.getEventDecisions,
    setEventActionMode: clientState.setEventActionMode,
  },
}));

import { CronJobDetail } from '../../../src/renderer/components/features/cron/CronJobDetail';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

function eventJob(overrides: Partial<CronJobDefinition> = {}): CronJobDefinition {
  return {
    id: 'job-listen',
    runsOn: 'local',
    name: '盯客服群',
    scheduleType: 'event',
    schedule: { type: 'event', source: 'connector', connector: 'mail', accountId: '_icloud', eventName: 'message' },
    action: { type: 'agent', agentType: 'default', prompt: '回复客户邮件' },
    enabled: true,
    actionMode: 'observe',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const decisions: CronEventDecision[] = [
  {
    id: 'd1', jobId: 'job-listen', kind: 'action', decision: 'would_act', reason: 'observe mode: mail_send intercepted before sending',
    runId: 'run-1', tool: 'mail_send', target: 'client@example.com', summary: 'Re: invoice — We will refund you today.', createdAt: 3,
  },
  { id: 'd2', jobId: 'job-listen', kind: 'event', eventId: 'm-7', decision: 'would_act', reason: '客户要求退款', runId: 'run-1', createdAt: 2 },
  { id: 'd3', jobId: 'job-listen', kind: 'event', eventId: 'm-8', decision: 'ignored', reason: '广告邮件', runId: 'run-1', createdAt: 1 },
];

beforeEach(() => {
  clientState.getEventDecisions.mockReset();
  clientState.setEventActionMode.mockReset();
  clientState.getEventDecisions.mockResolvedValue(decisions);
});

afterEach(() => {
  cleanup();
  useCronStore.setState({ jobs: [] });
});

describe('CronEventDecisionsPanel (via CronJobDetail)', () => {
  it('shows the observe badge and the decision list with would_act rows highlighted', async () => {
    render(<CronJobDetail job={eventJob()} />);
    const badge = screen.getByTestId('cron-action-mode-badge');
    expect(badge.getAttribute('data-mode')).toBe('observe');
    expect(badge.textContent).toContain('仅观察');

    const rows = await screen.findAllByTestId('cron-event-decision-row');
    expect(clientState.getEventDecisions).toHaveBeenCalledWith('job-listen');
    expect(rows.map((row) => row.getAttribute('data-decision'))).toEqual(['would_act', 'would_act', 'ignored']);
    expect(rows.map((row) => row.getAttribute('data-highlight'))).toEqual(['true', 'true', null]);
    expect(rows[0].textContent).toContain('本会执行');
    expect(rows[0].textContent).toContain('mail_send');
    expect(rows[0].textContent).toContain('client@example.com');
    expect(rows[0].textContent).toContain('We will refund you today.');
    expect(rows[2].textContent).toContain('广告邮件');
  });

  it('switch to auto opens a confirm modal; cancelling does not call the host', async () => {
    render(<CronJobDetail job={eventJob()} />);
    fireEvent.click(screen.getByTestId('cron-switch-to-auto'));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByText('让这个自动化开始真实执行？')).toBeTruthy();
    fireEvent.click(screen.getByText('先不切换'));
    expect(clientState.setEventActionMode).not.toHaveBeenCalled();
  });

  it('confirming the modal calls setEventActionMode(auto) and updates the job in the store', async () => {
    const job = eventJob();
    useCronStore.setState({ jobs: [job] });
    clientState.setEventActionMode.mockResolvedValue({ ...job, actionMode: 'auto', updatedAt: 2 });
    render(<CronJobDetail job={job} />);
    fireEvent.click(screen.getByTestId('cron-switch-to-auto'));
    await act(async () => { fireEvent.click(await screen.findByText('确认切换')); });
    expect(clientState.setEventActionMode).toHaveBeenCalledWith('job-listen', 'auto');
    await waitFor(() => expect(useCronStore.getState().jobs[0]?.actionMode).toBe('auto'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('auto mode shows the auto badge and no switch action; time-based jobs show no panel', async () => {
    const { unmount } = render(<CronJobDetail job={eventJob({ actionMode: 'auto' })} />);
    expect(screen.getByTestId('cron-action-mode-badge').getAttribute('data-mode')).toBe('auto');
    expect(screen.queryByTestId('cron-switch-to-auto')).toBeNull();
    await screen.findAllByTestId('cron-event-decision-row');
    unmount();
    render(<CronJobDetail job={eventJob({ scheduleType: 'cron', schedule: { type: 'cron', expression: '0 9 * * *' }, actionMode: undefined })} />);
    expect(screen.queryByTestId('cron-event-decisions')).toBeNull();
  });

  it('a failed switch keeps the modal open and shows the error', async () => {
    clientState.setEventActionMode.mockRejectedValue(new Error('record missing'));
    render(<CronJobDetail job={eventJob()} />);
    fireEvent.click(screen.getByTestId('cron-switch-to-auto'));
    await act(async () => { fireEvent.click(await screen.findByText('确认切换')); });
    expect((await screen.findByRole('alert')).textContent).toContain('record missing');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
