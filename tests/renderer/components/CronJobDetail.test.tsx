// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';

vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    getGroupListenCheck: vi.fn().mockResolvedValue({ status: 'idle' }),
    startGroupListenCheck: vi.fn(),
    listJobs: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue(null),
    getExecutions: vi.fn().mockResolvedValue([]),
  },
}));

import { CronJobDetail } from '../../../src/renderer/components/features/cron/CronJobDetail';
import { CRON_EVENT_TRIGGER } from '../../../src/shared/constants/cronEventTrigger';
import { CronGroupListenChecks } from '../../../src/host/cron/cronGroupListenCheck';
import { CronGroupListenCheck } from '../../../src/renderer/components/features/cron/CronGroupListenCheck';
import { cronClient } from '../../../src/renderer/services/cronClient';
import { ChannelModal } from '../../../src/renderer/components/features/settings/tabs/ChannelsSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

function makeJob(overrides: Partial<CronJobDefinition>): CronJobDefinition {
  return {
    id: 'job-1',
    runsOn: 'local',
    name: '英语单词',
    scheduleType: 'cron',
    schedule: { type: 'cron', expression: '30 8 * * *' },
    action: { type: 'agent', agentType: 'general', prompt: '每天推荐 5 个英语单词' },
    enabled: true,
    maxRetries: 3,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  useCronStore.setState({ isEditorOpen: false, editingJobId: null, copyingJobId: null });
});

describe('CronJobDetail', () => {
  it('业务网格显示下次运行时间', () => {
    const next = Date.now() + 3_600_000;
    render(<CronJobDetail job={makeJob({ nextRunAt: next })} />);
    const card = screen.getByTestId('cron-detail-next-run');
    expect(card.textContent).toContain('下次运行');
    expect(card.textContent).not.toContain('—');
  });

  it('停用任务的下次运行显示占位符', () => {
    render(<CronJobDetail job={makeJob({ enabled: false, nextRunAt: Date.now() + 3_600_000 })} />);
    expect(screen.getByTestId('cron-detail-next-run').textContent).toContain('—');
  });

  it('重试/超时等工程参数收进高级折叠区且默认收起', () => {
    render(<CronJobDetail job={makeJob({ timeout: 60_000 })} />);
    const advanced = screen.getByTestId('cron-detail-advanced');
    expect(advanced.tagName).toBe('DETAILS');
    expect((advanced as HTMLDetailsElement).open).toBe(false);
    // 工程参数在折叠区内部而不在业务网格
    expect(advanced.textContent).toContain('最大重试');
    expect(advanced.textContent).toContain('超时');
  });

  it('空态显示选择引导', () => {
    render(<CronJobDetail job={null} />);
    expect(screen.getByText('选择一个任务查看详情')).toBeTruthy();
  });

  it('无描述时显示引导文案而不是「暂无描述」占位', () => {
    render(<CronJobDetail job={makeJob({ description: undefined })} />);
    expect(screen.getByTestId('cron-detail-description-guide').textContent).toContain(
      '让 Neo 给这个任务写一句描述',
    );
  });

  it('有描述时正常显示描述、不出现引导文案', () => {
    render(<CronJobDetail job={makeJob({ description: '每天背 5 个单词' })} />);
    expect(screen.getByText('每天背 5 个单词')).toBeTruthy();
    expect(screen.queryByTestId('cron-detail-description-guide')).toBeNull();
  });

  it('执行位置只读展示冻结说明，复制出口打开新任务编辑态', () => {
    render(<CronJobDetail job={makeJob({ runsOn: 'cloud' })} />);
    expect(screen.getByTestId('cron-runs-on-pill-cloud').textContent).toContain('云端');
    expect(screen.getByText('创建后不可更改')).toBeTruthy();

    fireEvent.click(screen.getByTestId('cron-copy-by-location'));
    expect(useCronStore.getState()).toMatchObject({
      isEditorOpen: true,
      editingJobId: null,
      copyingJobId: 'job-1',
    });
  });
});

it('offers the self-check in the detail of a newly created group listener', async () => {
  render(<CronJobDetail job={makeJob({
    scheduleType: 'event', schedule: { type: 'event', source: 'channel', accountId: 'feishu-1', chatId: 'group-1', eventName: 'message' },
  })} />);
  expect(await screen.findByRole('button', { name: '发条测试消息' })).toBeTruthy();
});

describe('Group listener receipt check', () => {
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
});

describe('Feishu onboarding checklist', () => {
  const initialLanguage = useAppStore.getState().language;
  afterEach(() => {
    cleanup();
    useAppStore.setState({ language: initialLanguage });
  });

  describe('Feishu setup permission checklist', () => {
    it.each([
      ['zh', true], ['zh', false], ['en', true], ['en', false],
    ] as const)('shows approval and no-mention scope in %s (WebSocket=%s)', (language, useWebSocket) => {
      useAppStore.setState({ language });
      render(<ChannelModal
        account={{
          id: 'test-account', name: 'Test Feishu', type: 'feishu', status: 'disconnected', enabled: true, createdAt: 1,
          config: { type: 'feishu', appId: 'test-app', appSecret: '', useWebSocket },
        }}
        channelTypes={[{ type: 'feishu', name: 'Feishu' }]}
        onSave={vi.fn()} onClose={vi.fn()}
      />);
      const checklist = screen.getByRole('region', { name: language === 'zh' ? '权限清单' : 'Permission checklist' });
      expect(checklist.textContent).toContain('im:message.group_msg');
      expect(checklist.textContent).toContain(language === 'zh' ? '租户管理员批准' : 'tenant administrator approval');
      expect(checklist.textContent).toContain(language === 'zh' ? '仅在无需 @ 的群监听中需要' : 'only needed for group listening without @mentions');
      expect(checklist.textContent).toContain(language === 'zh' ? '申请并发布版本' : 'Request it and publish a version');
    });
  });
});
