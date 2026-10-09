// @vitest-environment jsdom
// ============================================================================
// 事件触发任务创建 UI（N-CRON-EVENT-CREATE-UI）—— 验收 ①③②（renderer 侧）。
// ① 手动配置里选「通道消息（群监听）」→ 选账号 + 群 → createJob 收到预期的
//    EventScheduleConfig；不选群 = chatId 缺省（任意会话）。
// ③ 非法配置在表单里报出（r2：只在提交过/动过事件字段后才显示，且按 shared
//    校验器的 reason 映射成 zh 文案——判据同一份，呈现本地化）。
// ② 建好的 event 任务出现在列表/详情里，摘要显示通道目录的账号名/群名
//    （目录没有回落 id），详情页可停用（enabled=false）/删除。
// 「停用后不再触发」的 host 侧行为在 tests/unit/cron/cronEventTrigger.test.ts。
// ============================================================================
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ChannelAccount } from '../../../src/shared/contract/channel';
import { validateEventScheduleConstraints } from '../../../src/shared/cronEventValidation';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';
import { cronCenterZh } from '../../../src/renderer/i18n/cronCenter';

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(() => () => undefined),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({ default: ipc }));
vi.mock('../../../src/renderer/hooks/useMcpServerStates', () => ({
  useMcpServerStates: () => [],
}));

import { CronJobEditor } from '../../../src/renderer/components/features/cron/CronJobEditor';
import { CronJobList } from '../../../src/renderer/components/features/cron/CronJobList';
import { CronJobDetail } from '../../../src/renderer/components/features/cron/CronJobDetail';
import {
  buildCronJobInput,
  buildDraftFromJob,
  formatScheduleSummary,
} from '../../../src/renderer/components/features/cron/types';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

const feishuAccount: ChannelAccount = {
  id: 'account-feishu',
  name: '工作飞书',
  type: 'feishu',
  config: { type: 'feishu', appId: 'app-id', appSecret: 'app-secret' },
  status: 'connected',
  enabled: true,
  createdAt: 1,
};

const telegramAccount: ChannelAccount = {
  id: 'account-telegram',
  name: '家用 bot',
  type: 'telegram',
  config: { type: 'telegram', botToken: 'token' },
  status: 'connected',
  enabled: true,
  createdAt: 1,
};

function mockChannelCatalog(accounts: ChannelAccount[]): void {
  // 未知通道一律 resolve undefined（简单创建流会顺手拉项目/角色列表，别在这里炸）。
  ipc.invoke.mockImplementation(async (channel: string, accountId?: string) => {
    if (channel === IPC_CHANNELS.CHANNEL_LIST_ACCOUNTS) return accounts;
    if (channel === IPC_CHANNELS.CHANNEL_LIST_CONVERSATIONS && accountId === feishuAccount.id) {
      return { supported: true, conversations: [{ id: 'oc_group', name: '林晨, 苏三' }] };
    }
    if (channel === IPC_CHANNELS.CHANNEL_LIST_CONVERSATIONS && accountId === telegramAccount.id) {
      return { supported: false, conversations: [] };
    }
    return undefined;
  });
}

function makeEventJob(overrides: Partial<CronJobDefinition> = {}): CronJobDefinition {
  return {
    id: 'job-event',
    name: '盯群消息',
    scheduleType: 'event',
    schedule: {
      type: 'event',
      source: 'channel',
      accountId: 'account-feishu',
      chatId: 'oc_group',
      eventName: 'message',
    },
    action: { type: 'agent', agentType: 'default', prompt: '处理新消息' },
    runsOn: 'local',
    maxRunBudget: 1,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/** reason → 本地化文案（生产同款映射）：期望值跟着 i18n 走，不在测试里复抄一遍。 */
function localizedCopy(reason: keyof typeof cronCenterZh.cronCenter.eventValidation): string {
  return cronCenterZh.cronCenter.eventValidation[reason];
}

/** FormField 没有给所有标签挂 htmlFor，按「标签文本 → 同级控件」取输入元素。 */
function controlForLabel(label: string | RegExp): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const labelEl = screen.getByText(label);
  const control = labelEl.parentElement?.querySelector('input, textarea, select');
  if (!control) throw new Error(`no control found for label ${label}`);
  return control as HTMLInputElement;
}

async function openManualEditor(): Promise<void> {
  render(<CronJobEditor isOpen job={null} onClose={() => undefined} />);
  fireEvent.click(screen.getByText('手动配置'));
  await waitFor(() => expect(screen.getByText('调度方式')).toBeTruthy());
}

/** 选中 event 调度并停在基本设置页（什么都不填）。 */
async function selectEventSchedule(): Promise<void> {
  fireEvent.change(controlForLabel('调度类型'), { target: { value: 'event' } });
  await screen.findByLabelText(/^触发账号/);
}

/** 走到可提交状态：event 调度 + 账号（+可选群）+ agent 动作 + 预算（事件字段里就有一个）。 */
async function fillEventJob(options: { chat?: 'group' | 'manual' | 'none'; budget?: string } = {}): Promise<void> {
  await selectEventSchedule();

  if (options.chat === 'manual') {
    fireEvent.change(screen.getByLabelText(/^触发账号/), { target: { value: telegramAccount.id } });
    const manual = await screen.findByLabelText('会话 / 群 ID（可选）');
    fireEvent.change(manual, { target: { value: '-10001' } });
  } else {
    fireEvent.change(screen.getByLabelText(/^触发账号/), { target: { value: feishuAccount.id } });
    if (options.chat === 'group') {
      const chatSelect = await screen.findByLabelText('限定会话 / 群（可选）');
      fireEvent.change(chatSelect, { target: { value: 'oc_group' } });
    }
  }

  // 预算输入在事件字段里（r2），不再绕去「高级选项」找。
  fireEvent.change(controlForLabel(/^单次预算上限/), {
    target: { value: options.budget ?? '0.5' },
  });

  fireEvent.change(controlForLabel('任务名称'), { target: { value: '盯群消息' } });

  fireEvent.click(screen.getByText('执行动作'));
  fireEvent.change(controlForLabel('Agent 类型'), { target: { value: 'default' } });
  fireEvent.change(controlForLabel('Prompt'), { target: { value: '处理新消息' } });

  // 回到基本设置页：事件字段与内联护栏提示挂在这里（tab 卸载式渲染）。
  fireEvent.click(screen.getByText('基本设置'));
}

beforeEach(() => {
  vi.clearAllMocks();
  ipc.on.mockReturnValue(() => undefined);
  mockChannelCatalog([feishuAccount, telegramAccount]);
  useCronStore.setState({
    jobs: [],
    stats: null,
    latestExecutions: {},
    executionsByJobId: {},
    selectedJobId: null,
    filterMode: 'all',
    searchQuery: '',
    isLoading: false,
    isEditorOpen: false,
    editingJobId: null,
    copyingJobId: null,
    error: null,
    createJob: vi.fn(),
    updateJob: vi.fn(),
    deleteJob: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('① 手动配置创建事件任务', () => {
  it('选账号 + 群 → createJob 收到带 chatId 的 EventScheduleConfig（群监听绑定）', async () => {
    await openManualEditor();
    await fillEventJob({ chat: 'group' });

    fireEvent.click(screen.getByText('创建任务'));

    const createJob = useCronStore.getState().createJob as Mock;
    await waitFor(() => expect(createJob).toHaveBeenCalledTimes(1));
    const input = createJob.mock.calls[0][0];
    expect(input.schedule).toEqual({
      type: 'event',
      source: 'channel',
      accountId: 'account-feishu',
      chatId: 'oc_group',
      eventName: 'message',
    });
    expect(input.scheduleType).toBe('event');
    expect(input.runsOn).toBe('local');
    expect(input.action).toMatchObject({ type: 'agent', agentType: 'default' });
    expect(input.maxRunBudget).toBe(0.5);
  });

  it('不选群 → chatId 缺省（该账号任意会话）', async () => {
    await openManualEditor();
    await fillEventJob({ chat: 'none' });

    fireEvent.click(screen.getByText('创建任务'));

    const createJob = useCronStore.getState().createJob as Mock;
    await waitFor(() => expect(createJob).toHaveBeenCalledTimes(1));
    const input = createJob.mock.calls[0][0];
    expect(input.schedule).toEqual({
      type: 'event',
      source: 'channel',
      accountId: 'account-feishu',
      eventName: 'message',
    });
  });

  it('不能列出会话的通道退化为手填群 ID，绑定照常成立', async () => {
    await openManualEditor();
    await fillEventJob({ chat: 'manual' });

    fireEvent.click(screen.getByText('创建任务'));

    const createJob = useCronStore.getState().createJob as Mock;
    await waitFor(() => expect(createJob).toHaveBeenCalledTimes(1));
    const input = createJob.mock.calls[0][0];
    expect(input.schedule).toEqual({
      type: 'event',
      source: 'channel',
      accountId: 'account-telegram',
      chatId: '-10001',
      eventName: 'message',
    });
  });

  it('buildDraftFromJob 还原 event 绑定，编辑不再被面板拒绝', () => {
    const draft = buildDraftFromJob(makeEventJob());
    expect(draft.scheduleType).toBe('event');
    expect(draft.eventAccountId).toBe('account-feishu');
    expect(draft.eventChatId).toBe('oc_group');
    expect(draft.runsOn).toBe('local');
    expect(() => buildCronJobInput(draft)).not.toThrow();
  });

  it('buildCronJobInput 的兜底护栏仍抛 shared 校验器英文原文（host 同款，byte-identical）', () => {
    const draft = { ...buildDraftFromJob(makeEventJob()), eventAccountId: ' ' };
    const violation = validateEventScheduleConstraints({
      schedule: { type: 'event', source: 'channel', eventName: 'message', accountId: ' ' },
      runsOn: 'local',
      action: { type: 'agent' },
      maxRunBudget: 1,
    });
    expect(violation?.reason).toBe('invalid-schedule');
    expect(() => buildCronJobInput(draft)).toThrow(violation?.message);
  });
});

describe('③ 表单内护栏（同判据、本地化呈现、提交/触碰后才显示）', () => {
  it('选完「通道消息」什么都没填：不出校验框（不因选中调度类型就报红）', async () => {
    await openManualEditor();
    await selectEventSchedule();

    expect(screen.queryByTestId('cron-event-validation')).toBeNull();
    // 没到显示时机时，提交也不该把英文原文漏出来。
    fireEvent.click(screen.getByText('创建任务'));
    await waitFor(() => expect(screen.getByTestId('cron-event-validation')).toBeTruthy());
    expect(useCronStore.getState().createJob).not.toHaveBeenCalled();
  });

  it('没选账号就提交：表单与内联都是 invalid-schedule 的 zh 文案，createJob 不被调用', async () => {
    await openManualEditor();
    await selectEventSchedule();

    const violation = validateEventScheduleConstraints({
      schedule: { type: 'event', source: 'channel', eventName: 'message', accountId: '' },
      runsOn: 'local',
      action: { type: 'agent' }, // 编辑器把 event 钉为 agent
      maxRunBudget: null,
    });
    expect(violation?.reason).toBe('invalid-schedule');
    const expected = localizedCopy('invalid-schedule');

    fireEvent.click(screen.getByText('创建任务'));

    // 提交后：内联提示 + 表单错误框都是同一句 zh 文案（不是校验器英文原文）。
    await waitFor(() => expect(screen.getAllByText(expected).length).toBeGreaterThanOrEqual(2));
    expect(screen.getByTestId('cron-event-validation').textContent).toBe(expected);
    expect(screen.queryByText(violation?.message ?? '')).toBeNull();
    expect(useCronStore.getState().createJob).not.toHaveBeenCalled();
  });

  it('没设预算就提交：报 requires-budget 的 zh 文案，并指向事件字段里的预算输入', async () => {
    await openManualEditor();
    await fillEventJob({ chat: 'group', budget: '' });

    const violation = validateEventScheduleConstraints({
      schedule: { type: 'event', source: 'channel', eventName: 'message', accountId: 'account-feishu' },
      runsOn: 'local',
      action: { type: 'agent' },
      maxRunBudget: null,
    });
    expect(violation?.reason).toBe('requires-budget');
    const expected = localizedCopy('requires-budget');
    expect(expected).toContain('单次预算上限');

    fireEvent.click(screen.getByText('创建任务'));

    await waitFor(() => expect(screen.getAllByText(expected).length).toBeGreaterThanOrEqual(2));
    expect(useCronStore.getState().createJob).not.toHaveBeenCalled();
  });

  it('动过预算字段（清空）不用提交就亮内联提示；填回去提示消失', async () => {
    await openManualEditor();
    await fillEventJob({ chat: 'group', budget: '0.5' });
    expect(screen.queryByTestId('cron-event-validation')).toBeNull();

    fireEvent.change(controlForLabel(/^单次预算上限/), { target: { value: '' } });
    expect(screen.getByTestId('cron-event-validation').textContent).toBe(localizedCopy('requires-budget'));

    fireEvent.change(controlForLabel(/^单次预算上限/), { target: { value: '0.5' } });
    await waitFor(() => expect(screen.queryByTestId('cron-event-validation')).toBeNull());
  });
});

describe('② 列表/详情可见 + 停用/删除', () => {
  it('列表摘要显示通道目录的账号名/群名（不再是内部 ID），触发源 chip 标「事件」', async () => {
    useCronStore.setState({ jobs: [makeEventJob()] });
    render(<CronJobList />);

    await waitFor(() =>
      expect(screen.getByTestId('cron-job-schedule-summary').textContent).toBe('通道消息 · 工作飞书 · 林晨, 苏三'));
    expect(screen.getByText('盯群消息')).toBeTruthy();
    expect(screen.getByTestId('cron-job-trigger-kind').textContent).toBe('事件');
  });

  it('目录里没有的账号/群回落 ID；未限定会话在「任意会话」档', async () => {
    useCronStore.setState({
      jobs: [
        makeEventJob({
          schedule: { type: 'event', source: 'channel', accountId: 'acc-gone', chatId: 'oc_unknown', eventName: 'message' },
        }),
        makeEventJob({
          id: 'job-any',
          schedule: { type: 'event', source: 'channel', accountId: 'account-feishu', eventName: 'message' },
        }),
      ],
    });
    render(<CronJobList />);

    const summaries = await screen.findAllByTestId('cron-job-schedule-summary');
    await waitFor(() => expect(summaries.map((el) => el.textContent)).toEqual([
      '通道消息 · acc-gone · oc_unknown',
      '通道消息 · 工作飞书 · 任意会话',
    ]));
  });

  it('详情页摘要显示账号名/群名；停用走 updateJob(enabled=false)，删除走 deleteJob', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    useCronStore.setState({
      jobs: [makeEventJob()],
      loadExecutions: vi.fn(),
      openEditEditor: vi.fn(),
      openCopyEditor: vi.fn(),
      triggerJob: vi.fn(async () => null),
      updateJob: vi.fn(async () => null),
      deleteJob: vi.fn(async () => true),
    });
    render(<CronJobDetail job={makeEventJob()} />);

    expect(screen.getByText('盯群消息')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('通道消息 · 工作飞书 · 林晨, 苏三')).toBeTruthy());

    fireEvent.click(screen.getByText('停用'));
    await waitFor(() =>
      expect(useCronStore.getState().updateJob).toHaveBeenCalledWith('job-event', { enabled: false }));

    fireEvent.click(screen.getByText('删除'));
    await waitFor(() => expect(useCronStore.getState().deleteJob).toHaveBeenCalledWith('job-event'));
    expect(confirmSpy).toHaveBeenCalled();
  });

  it('formatScheduleSummary 的 event 档（zh/en、显示名优先、缺名回落 id）', () => {
    expect(formatScheduleSummary(makeEventJob(), 'zh', { accountName: '工作飞书', chatName: '林晨, 苏三' }))
      .toBe('通道消息 · 工作飞书 · 林晨, 苏三');
    expect(formatScheduleSummary(makeEventJob(), 'en', { accountName: 'Feishu Work' }))
      .toBe('Channel message · Feishu Work · oc_group');
    // 目录缺名字（未加载/已删除）时回落 id。
    expect(formatScheduleSummary(makeEventJob(), 'zh')).toBe('通道消息 · account-feishu · oc_group');
    const anyChat = makeEventJob({ schedule: { type: 'event', source: 'channel', accountId: 'a1', eventName: 'message' } });
    expect(formatScheduleSummary(anyChat, 'en', { accountName: 'A1' })).toBe('Channel message · A1 · any chat');
  });
});
