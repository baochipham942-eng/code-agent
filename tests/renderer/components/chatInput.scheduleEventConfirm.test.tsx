// @vitest-environment jsdom
// ============================================================================
// /schedule 事件草案（N-CRON-EVENT-CREATE-CHAT）—— renderer 侧验收：
// - normalizeScheduleDraft：event 草案收下（accountId 允许空、groupName 剥成草稿级
//   提示、预算/本机/scheduleType 落默认）；mail(connector) 源与非 agent 动作拒绝；
//   非 event 草案不受影响（含误带 groupName 的剥离）。
// - 确认卡：event 草案出 群/预算 行、没有「什么时候」行与时间编辑器；按群名预选群；
//   预算预填 0.5 且可改；确认按钮在账号未选/预算非正时禁用、选完启用。
// - confirmScheduleCreation：合法 event 草案的 createJob 载荷（schedule 字段、
//   maxRunBudget 数字、runsOn local、createdVia）；非法草案纵深拒绝（不调 createJob）。
// ============================================================================
import React, { useState } from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelAccount } from '../../../src/shared/contract/channel';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import type { CreateCronJobInput } from '../../../src/renderer/services/cronClient';
import { cronCenterZh } from '../../../src/renderer/i18n/cronCenter';

const mocks = vi.hoisted(() => ({
  generateFromPrompt: vi.fn(),
  createJob: vi.fn(),
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(() => () => undefined),
}));

vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    generateFromPrompt: mocks.generateFromPrompt,
    createJob: mocks.createJob,
  },
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: ipc }));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: mocks.toast }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

import {
  useChatInputSubmit,
  type UseChatInputSubmitParams,
} from '../../../src/renderer/components/features/chat/ChatInput/useChatInputSubmit';
import { ScheduleConfirmCard } from '../../../src/renderer/components/features/chat/ChatInput/ScheduleConfirmCard';
import {
  buildScheduleConfirmRows,
  normalizeScheduleDraft,
} from '../../../src/renderer/components/features/chat/ChatInput/scheduleConfirm';
import { useScheduleDraft } from '../../../src/renderer/components/features/chat/ChatInput/useScheduleDraft';
import type { PendingScheduleDraft } from '../../../src/renderer/components/features/chat/ChatInput/useScheduleDraft';

const feishuAccount: ChannelAccount = {
  id: 'account-feishu',
  name: '工作飞书',
  type: 'feishu',
  config: { type: 'feishu', appId: 'app-id', appSecret: 'app-secret' },
  status: 'connected',
  enabled: true,
  createdAt: 1,
};

const eventDraftFromModel = {
  name: '盯发布群',
  description: '关注发布群，有人提到发布就总结',
  enabled: true,
  scheduleType: 'event',
  schedule: { type: 'event', source: 'channel', eventName: 'message' },
  action: { type: 'agent', agentType: 'default', prompt: '有人提到发布就总结给我' },
  groupName: '发布群',
  restatement: { what: '盯着发布群的新消息', notifyWhen: '有人提到发布时' },
};

const createdJob = {
  ...eventDraftFromModel,
  id: 'job-event-1',
  createdAt: 1,
  updatedAt: 1,
};

function makeEventPending(overrides: Partial<PendingScheduleDraft> = {}): PendingScheduleDraft {
  const normalized = normalizeScheduleDraft(eventDraftFromModel);
  if (!normalized) throw new Error('event draft should normalize');
  return {
    input: normalized.input,
    restatement: normalized.restatement,
    description: '关注发布群，有人提到发布就总结给我',
    sourceSessionId: 'session-1',
    eventGroupName: normalized.eventGroupName,
    ...overrides,
  };
}

function makeParams(overrides: Partial<UseChatInputSubmitParams> = {}): UseChatInputSubmitParams {
  return {
    value: '',
    attachments: [],
    voiceInputContext: null,
    pendingAppshot: null,
    pendingPromptCommand: null,
    pendingAgentSelection: null,
    currentSessionId: 'session-1',
    isProcessing: false,
    disabled: false,
    isUploading: false,
    onSend: vi.fn().mockResolvedValue(true),
    agentEntries: [],
    buildEnvelope: vi.fn((content: string) => ({ content })) as never,
    openAgentCommand: vi.fn(),
    addToInputHistory: vi.fn(),
    clearAppshot: vi.fn(),
    inputAreaRef: { current: { focus: vi.fn() } } as React.RefObject<any>,
    setValue: vi.fn(),
    setAttachments: vi.fn(),
    setVoiceInputContext: vi.fn(),
    setPendingPromptCommand: vi.fn(),
    setPendingAgentSelection: vi.fn(),
    setScheduleComposerOpen: vi.fn(),
    openGoalConfirm: vi.fn(),
    closeGoalConfirm: vi.fn(),
    openSeedComposer: vi.fn(),
    setActiveAgentId: vi.fn(),
    ...overrides,
  };
}

function useScheduleSubmitHarness() {
  const schedule = useScheduleDraft('session-1');
  const submit = useChatInputSubmit(makeParams({ scheduleDraft: schedule }));
  return { ...schedule, ...submit };
}

/** 有状态宿主：真实复刻「卡内编辑 → onDraftChange → 父状态 → 卡重渲染」的回路。 */
function DraftHost({ initial }: { initial: PendingScheduleDraft }) {
  const [draft, setDraft] = useState(initial);
  return (
    <ScheduleConfirmCard
      draft={draft}
      confirming={false}
      onConfirm={() => undefined}
      onDismiss={() => undefined}
      onDraftChange={setDraft}
    />
  );
}

/** 确认按钮是 data-* 属性挂载（非 data-testid），与存量测试同一查法。 */
function confirmButton(): HTMLButtonElement {
  const el = document.querySelector('[data-schedule-confirm-submit]');
  if (!el) throw new Error('confirm button not rendered');
  return el as HTMLButtonElement;
}

function mockChannelCatalog(): void {
  ipc.invoke.mockImplementation(async (channel: string, accountId?: string) => {
    if (channel === IPC_CHANNELS.CHANNEL_LIST_ACCOUNTS) return [feishuAccount];
    if (channel === IPC_CHANNELS.CHANNEL_LIST_CONVERSATIONS && accountId === feishuAccount.id) {
      return { supported: true, conversations: [{ id: 'oc_release', name: '发布群' }, { id: 'oc_random', name: '闲聊群' }] };
    }
    return undefined;
  });
}

describe('event schedule draft normalization', () => {
  it('accepts a channel event draft: empty accountId, groupName stripped to a hint, defaults applied', () => {
    const normalized = normalizeScheduleDraft(eventDraftFromModel);
    expect(normalized).not.toBeNull();
    expect(normalized?.eventGroupName).toBe('发布群');
    const input = normalized?.input as Record<string, unknown>;
    expect(input.groupName).toBeUndefined();
    expect(input.schedule).toEqual({ type: 'event', source: 'channel', eventName: 'message', accountId: '' });
    expect(input.scheduleType).toBe('event');
    expect(input.runsOn).toBe('local');
    expect(input.maxRunBudget).toBe(0.5);
    expect(input.action).toEqual({ type: 'agent', agentType: 'default', prompt: '有人提到发布就总结给我' });
  });

  it('keeps a model-provided positive budget instead of the default', () => {
    const normalized = normalizeScheduleDraft({ ...eventDraftFromModel, maxRunBudget: 2 });
    expect((normalized?.input as Record<string, unknown>).maxRunBudget).toBe(2);
  });

  it('rejects mail-style connector event drafts (no creation UI for that source)', () => {
    const mailDraft = {
      ...eventDraftFromModel,
      schedule: { type: 'event', source: 'connector', connector: 'mail', eventName: 'message', accountId: 'me@local' },
    };
    expect(normalizeScheduleDraft(mailDraft)).toBeNull();
  });

  it('rejects non-message event names and non-agent actions on event drafts', () => {
    expect(normalizeScheduleDraft({
      ...eventDraftFromModel,
      schedule: { type: 'event', source: 'channel', eventName: 'pin' },
    })).toBeNull();
    expect(normalizeScheduleDraft({
      ...eventDraftFromModel,
      action: { type: 'shell', command: 'echo hi' },
    })).toBeNull();
  });

  it('leaves a non-event draft unchanged and strips a stray groupName from its input', () => {
    const normalized = normalizeScheduleDraft({
      name: '每日巡检',
      enabled: true,
      scheduleType: 'cron',
      schedule: { type: 'cron', expression: '17 9 * * *' },
      action: { type: 'agent', agentType: 'default', prompt: '巡检' },
      groupName: '发布群',
    });
    expect(normalized).not.toBeNull();
    expect(normalized?.eventGroupName).toBeUndefined();
    const input = normalized?.input as Record<string, unknown>;
    expect(input.groupName).toBeUndefined();
    expect(input.scheduleType).toBe('cron');
    expect(input.maxRunBudget).toBeUndefined();
    expect(input.runsOn).toBeUndefined();
  });

  it('builds event rows: group + budget replace the when row', () => {
    const pending = makeEventPending();
    const rows = buildScheduleConfirmRows(pending, {
      what: '检查什么', when: '什么时候', notifyWhen: '什么变化值得通知', result: '结果送到哪里',
      fallbackWhat: '按任务描述执行', fallbackNotifyWhen: '完成时通知', reviewInbox: '自动化审核收件箱',
    }, 'zh', {
      group: cronCenterZh.cronCenter.eventConfirmGroup,
      groupFallback: cronCenterZh.cronCenter.eventConfirmGroupFallback,
      groupAnyChat: cronCenterZh.cronCenter.eventConfirmGroupAnyChat,
      budget: cronCenterZh.cronCenter.eventBudgetLabel,
    });
    expect(rows.map((row) => row.key)).toEqual(['what', 'group', 'notifyWhen', 'budget', 'result']);
    expect(rows.find((row) => row.key === 'group')?.value).toBe('发布群');
    expect(rows.find((row) => row.key === 'budget')?.value).toBe('0.5');
  });
});

describe('event schedule confirm card', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChannelCatalog();
  });

  it('renders group/budget rows with no "when" row, budget pre-filled 0.5, confirm disabled until account and group are chosen', async () => {
    render(<DraftHost initial={makeEventPending()} />);

    // 行：what / group / notifyWhen / budget / result，没有「什么时候」。
    expect(screen.getByText('监听哪个群')).toBeTruthy();
    // 预算文案出现两处（行标签 + 字段标签），断言至少在卡上明示。
    expect(screen.getAllByText(/单次预算上限/).length).toBeGreaterThan(0);
    expect(screen.getByText('0.5')).toBeTruthy();
    expect(screen.queryByText('什么时候')).toBeNull();
    expect(document.querySelector('[data-schedule-when-editor]')).toBeNull();

    // 未选账号：确认禁用 + 共享校验器的本地化提示。
    expect(confirmButton().disabled).toBe(true);
    expect(screen.getByText(cronCenterZh.cronCenter.eventValidation['invalid-schedule'])).toBeTruthy();

    // 选账号 → 目录加载 → 按用户原话群名「发布群」预选群 → 校验通过、确认启用。
    fireEvent.change(await screen.findByLabelText(/^触发账号/), { target: { value: feishuAccount.id } });
    const chatSelect = await screen.findByLabelText('限定会话 / 群（可选）') as HTMLSelectElement;
    await waitFor(() => expect(chatSelect.value).toBe('oc_release'));
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
  });

  it('budget is editable: changing it updates the row and a non-positive value disables confirm', async () => {
    render(<DraftHost initial={makeEventPending()} />);

    const budgetInput = await screen.findByLabelText(/^单次预算上限/);
    fireEvent.change(budgetInput, { target: { value: '2' } });
    expect(await screen.findByText('2')).toBeTruthy();

    fireEvent.change(await screen.findByLabelText(/^触发账号/), { target: { value: feishuAccount.id } });
    await waitFor(() => expect(confirmButton().disabled).toBe(false));

    fireEvent.change(budgetInput, { target: { value: '0' } });
    await waitFor(() => expect(confirmButton().disabled).toBe(true));
    expect(screen.getByText(cronCenterZh.cronCenter.eventValidation['requires-budget'])).toBeTruthy();
  });

  it('shows the no-account hint with a connect action when no channel account exists', async () => {
    ipc.invoke.mockImplementation(async (channel: string) => {
      if (channel === IPC_CHANNELS.CHANNEL_LIST_ACCOUNTS) return [];
      return undefined;
    });
    render(<DraftHost initial={makeEventPending()} />);

    expect(await screen.findByText(cronCenterZh.cronCenter.eventNoAccounts)).toBeTruthy();
    expect(screen.getByText(cronCenterZh.cronCenter.resultPushConnect)).toBeTruthy();
    expect(confirmButton().disabled).toBe(true);
  });
});

describe('event schedule creation through the chat input pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChannelCatalog();
    mocks.generateFromPrompt.mockResolvedValue(eventDraftFromModel);
    mocks.createJob.mockResolvedValue(createdJob);
  });

  it('stores the normalized event draft and only calls createJob after confirm', async () => {
    const { result } = renderHook(() => useScheduleSubmitHarness());

    await act(async () => {
      await result.current.runScheduleCreation('关注发布群，有人提到发布就总结给我');
    });

    const pending = result.current.pendingScheduleDraft;
    expect(pending?.eventGroupName).toBe('发布群');
    expect((pending?.input as Record<string, unknown>).groupName).toBeUndefined();
    expect(mocks.createJob).not.toHaveBeenCalled();

    // 模拟确认卡内的账号/群选择（写回草案）。store 与 confirm 分两个 act：
    // confirmScheduleCreation 闭包绑定 pendingScheduleDraft，要等重渲染后才拿到新草案。
    const schedule = (pending?.input as CreateCronJobInput).schedule as unknown as Record<string, unknown>;
    act(() => {
      result.current.storePendingScheduleDraft({
        ...pending!,
        input: {
          ...pending!.input,
          schedule: { ...schedule, accountId: 'account-feishu', chatId: 'oc_release' },
        } as CreateCronJobInput,
      });
    });
    await act(async () => {
      await result.current.confirmScheduleCreation();
    });

    expect(mocks.createJob).toHaveBeenCalledTimes(1);
    const payload = mocks.createJob.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.schedule).toEqual({
      type: 'event', source: 'channel', eventName: 'message', accountId: 'account-feishu', chatId: 'oc_release',
    });
    expect(payload.scheduleType).toBe('event');
    expect(payload.runsOn).toBe('local');
    expect(payload.maxRunBudget).toBe(0.5);
    expect((payload.metadata as Record<string, unknown>).createdVia).toBe('slash_schedule');
    expect(mocks.toast.success).toHaveBeenCalledTimes(1);
  });

  it('refuses to confirm an invalid event draft (defence in depth): no createJob, readable toast, draft kept', async () => {
    const { result } = renderHook(() => useScheduleSubmitHarness());

    await act(async () => {
      await result.current.runScheduleCreation('关注发布群，有人提到发布就总结给我');
    });
    expect(result.current.pendingScheduleDraft).not.toBeNull();

    await act(async () => {
      await result.current.confirmScheduleCreation();
    });

    expect(mocks.createJob).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalledWith(cronCenterZh.cronCenter.eventValidation['invalid-schedule']);
    // 草案保留：用户补选账号后还能确认。
    expect(result.current.pendingScheduleDraft).not.toBeNull();
  });

  it('strips an empty chatId from the confirmed payload (any-chat must not ship as "")', async () => {
    const { result } = renderHook(() => useScheduleSubmitHarness());

    await act(async () => {
      await result.current.runScheduleCreation('关注发布群，有人提到发布就总结给我');
    });
    const pending = result.current.pendingScheduleDraft!;
    const schedule = pending.input.schedule as unknown as Record<string, unknown>;
    act(() => {
      result.current.storePendingScheduleDraft({
        ...pending,
        input: { ...pending.input, schedule: { ...schedule, accountId: 'account-feishu', chatId: '' } } as CreateCronJobInput,
      });
    });
    await act(async () => {
      await result.current.confirmScheduleCreation();
    });

    expect(mocks.createJob).toHaveBeenCalledTimes(1);
    const payload = mocks.createJob.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.schedule).not.toHaveProperty('chatId');
  });
});
