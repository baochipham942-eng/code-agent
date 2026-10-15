// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';
import { CRON_EVENT_TRIGGER } from '../../../src/shared/constants/cronEventTrigger';
import { CronGroupListenChecks } from '../../../src/host/cron/cronGroupListenCheck';
import { CronGroupListenCheck } from '../../../src/renderer/components/features/cron/CronGroupListenCheck';
import { cronClient } from '../../../src/renderer/services/cronClient';

vi.mock('../../../src/renderer/services/cronClient', () => ({ cronClient: {
  getGroupListenCheck: vi.fn(), startGroupListenCheck: vi.fn(),
} }));

const job: CronJobDefinition = {
  id: 'job-1', name: 'Group check', enabled: true, runsOn: 'local', scheduleType: 'event',
  schedule: { type: 'event', source: 'channel', accountId: 'account-1', chatId: 'group-1', eventName: 'message' },
  action: { type: 'agent', agentType: 'default', prompt: 'Summarize' },
  createdAt: 1, updatedAt: 1,
};
let checks: CronGroupListenChecks;
const mount = async () => {
  await act(async () => { render(<CronGroupListenCheck jobId={job.id} />); });
};
const start = async () => {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '发条测试消息' })); });
};

beforeEach(() => {
  vi.useFakeTimers();
  checks = new CronGroupListenChecks(() => [job], Date.now);
  vi.mocked(cronClient.getGroupListenCheck).mockImplementation(async (id) => checks.get(id));
  vi.mocked(cronClient.startGroupListenCheck).mockImplementation(async (id) => checks.get(id, true));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('Group listen self-check presentation', () => {
  it('offers instructions, waits after clicking and displays a real receipt as connected', async () => {
    await mount();
    expect(screen.getByText(/不要 @ 机器人/).textContent).toContain(`${CRON_EVENT_TRIGGER.GROUP_LISTEN_CHECK_MINUTES} 分钟`);
    expect(cronClient.startGroupListenCheck).not.toHaveBeenCalled();
    await start();
    expect(screen.getByRole('status').textContent).toBe('正在等待这个群的新消息…');
    checks.observe('account-1', {
      id: 'message-1', channelId: 'account-1', sender: { id: 'sender-1', name: 'Sender' },
      context: { chatId: 'group-1', chatType: 'group' }, content: 'test', timestamp: Date.now(),
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(CRON_EVENT_TRIGGER.GROUP_LISTEN_CHECK_POLL_MS); });
    expect(screen.getByRole('status').textContent).toBe('已连通');
    expect(screen.queryByText(/应用可能缺少/)).toBeNull();
  });

  it('shows the sensitive permission and admin publication path after timeout, then permits retry', async () => {
    await mount();
    await start();
    await act(async () => { await vi.advanceTimersByTimeAsync(CRON_EVENT_TRIGGER.GROUP_LISTEN_CHECK_MINUTES * 60_000); });
    expect(screen.getByRole('status').textContent).toContain('还没收到测试消息');
    const hint = screen.getByText(/应用可能缺少/).textContent;
    expect(hint).toContain('「获取群组中所有消息」');
    expect(hint).toContain('im:message.group_msg');
    expect(hint).toContain('敏感权限，需要租户管理员批准');
    expect(hint).toContain('飞书开放平台 → 应用 → 权限管理 → 搜索该权限 → 申请并发布版本');
    expect(screen.queryByText('已连通')).toBeNull();
    await start();
    expect(screen.getByRole('status').textContent).toBe('正在等待这个群的新消息…');
    expect(screen.queryByText(/应用可能缺少/)).toBeNull();
  });

  it('shows a retryable check error instead of reporting a missing permission on IPC failure', async () => {
    vi.mocked(cronClient.getGroupListenCheck).mockRejectedValueOnce(new Error('offline'));
    await mount();
    expect(screen.getByRole('status').textContent).toBe('暂时无法检查，请重试。');
    expect(screen.queryByText(/应用可能缺少/)).toBeNull();
    await start();
    expect(screen.getByRole('status').textContent).toBe('正在等待这个群的新消息…');
  });

  it('hides unsupported tasks and stops polling on unmount', async () => {
    vi.mocked(cronClient.getGroupListenCheck).mockResolvedValueOnce(null);
    await mount();
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    await mount();
    await start();
    cleanup();
    const count = vi.mocked(cronClient.getGroupListenCheck).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(CRON_EVENT_TRIGGER.GROUP_LISTEN_CHECK_POLL_MS * 2); });
    expect(cronClient.getGroupListenCheck).toHaveBeenCalledTimes(count);
  });
});
