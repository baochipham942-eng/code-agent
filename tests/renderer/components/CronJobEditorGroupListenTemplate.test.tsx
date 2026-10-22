// @vitest-environment jsdom
// ============================================================================
// 群监听模板的填参步骤（N-CRON-EVENT-CREATE-CHAT 验收 ②）：
// Automations → 新建 → 从模板创建 → 群监听卡 → 填参步骤只有「要做什么」一句话 +
// CronEventScheduleFields（触发账号/群/预算预填 0.5）—— 不出现 Agent 类型、
// Context(JSON)、调度类型、运行位置这些专家字段；填完创建的 createJob 载荷是
// event 调度 + agent 动作（prompt = 那句话）+ 本机 + 预算 0.5。
// ============================================================================
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelAccount } from '../../../src/shared/contract/channel';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import { cronCenterZh } from '../../../src/renderer/i18n/cronCenter';

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(() => () => undefined),
}));

const cronStore = vi.hoisted(() => ({
  createJob: vi.fn(),
  updateJob: vi.fn(),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({ default: ipc }));
vi.mock('../../../src/renderer/stores/cronStore', () => ({
  useCronStore: () => cronStore,
}));
vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({
  useMcpServerStates: () => [],
}));

import { CronJobEditor } from '../../../src/renderer/components/features/cron/CronJobEditor';

const feishuAccount: ChannelAccount = {
  id: 'account-feishu',
  name: '工作飞书',
  type: 'feishu',
  config: { type: 'feishu', appId: 'app-id', appSecret: 'app-secret' },
  status: 'connected',
  enabled: true,
  createdAt: 1,
};

const createdJob = {
  id: 'job-group-listen',
  name: '群监听',
  createdAt: 1,
  updatedAt: 1,
} as unknown as CronJobDefinition;

/** 模板字段的 FormField 没挂 htmlFor，按「标签文本 → 同级控件」取输入元素（同 CronEventEditor 测试）。 */
function controlForLabel(label: string | RegExp): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const labelEl = screen.getByText(label);
  const control = labelEl.parentElement?.querySelector('input, textarea, select');
  if (!control) throw new Error(`no control found for label ${label}`);
  return control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
}

async function openGroupListenFillStep(): Promise<void> {
  render(<CronJobEditor isOpen job={null} onClose={() => undefined} />);
  fireEvent.click(screen.getByText('从模板创建'));
  fireEvent.click(await screen.findByText('群监听'));
  // 填参步骤渲染出来：一句话字段在场。
  expect(await waitFor(() => controlForLabel(/^要做什么/))).toBeTruthy();
}

describe('group-listen template fill step', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipc.invoke.mockImplementation(async (channel: string, accountId?: string) => {
      if (channel === IPC_CHANNELS.CHANNEL_LIST_ACCOUNTS) return [feishuAccount];
      if (channel === IPC_CHANNELS.CHANNEL_LIST_CONVERSATIONS && accountId === feishuAccount.id) {
        return { supported: true, conversations: [{ id: 'oc_release', name: '发布群' }] };
      }
      return undefined;
    });
    cronStore.createJob.mockResolvedValue(createdJob);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows account/group/budget and the one-liner only — no expert fields', async () => {
    await openGroupListenFillStep();

    expect(await screen.findByLabelText(/^触发账号/)).toBeTruthy();
    // 预算预填 0.5。
    const budget = screen.getByLabelText(/^单次预算上限/) as HTMLInputElement;
    expect(budget.value).toBe('0.5');

    // 专家字段一律不出现：调度类型 / Agent 类型 / Context(JSON) / 运行位置选择器。
    expect(screen.queryByText('调度类型')).toBeNull();
    expect(screen.queryByText('Agent 类型')).toBeNull();
    expect(screen.queryByText('Context')).toBeNull();
    expect(screen.queryByTestId('cron-runs-on-selector')).toBeNull();
  });

  it('blocks creation with localized copy until an account is picked, then creates the event job payload', async () => {
    await openGroupListenFillStep();

    fireEvent.change(controlForLabel(/^要做什么/), { target: { value: '有人提到发布就总结给我' } });
    fireEvent.click(screen.getByText('创建任务'));
    // 没选账号：共享校验器的本地化文案同时出现在事件字段内联提示和表单错误框
    //（提交前 1 处 = 内联；提交后 2 处 = 加了错误框），不调 createJob。
    await waitFor(() => expect(
      screen.getAllByText(cronCenterZh.cronCenter.eventValidation['invalid-schedule']).length,
    ).toBeGreaterThanOrEqual(2));
    expect(cronStore.createJob).not.toHaveBeenCalled();

    fireEvent.change(await screen.findByLabelText(/^触发账号/), { target: { value: feishuAccount.id } });
    // 模板流没有群名提示（那是 /schedule 草案的 preselect），群由用户手选。
    const chatSelect = await screen.findByLabelText('限定会话 / 群（可选）') as HTMLSelectElement;
    fireEvent.change(chatSelect, { target: { value: 'oc_release' } });
    expect(chatSelect.value).toBe('oc_release');

    fireEvent.click(screen.getByText('创建任务'));
    await waitFor(() => expect(cronStore.createJob).toHaveBeenCalledTimes(1));
    const payload = cronStore.createJob.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.schedule).toEqual({
      type: 'event', source: 'channel', eventName: 'message', accountId: 'account-feishu', chatId: 'oc_release',
    });
    expect(payload.scheduleType).toBe('event');
    expect(payload.runsOn).toBe('local');
    expect(payload.maxRunBudget).toBe(0.5);
    expect((payload.action as Record<string, unknown>).prompt).toBe('有人提到发布就总结给我');
    expect((payload.action as Record<string, unknown>).type).toBe('agent');
  });
});
