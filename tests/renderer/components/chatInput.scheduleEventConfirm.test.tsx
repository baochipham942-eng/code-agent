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

// ============================================================================
// rework r1（2026-10-17 PR review Important 1-3）—— 三条回归钉子：
// 1) 同会话旧卡未确认时再次 /schedule 会整体替换草案（挂载点无 key、卡片不重挂），
//    卡内 event 编辑态必须随草案身份（draftId）重置，不得残留上一份草案的账号/群/预算。
// 2) 按群名预选只尝试一次：用户把群改回「任意会话」后不能被弹回同名群。
// 3) 「监听哪个群」行摘要随卡内实际绑定走（目录显示名），不再恒显原话群名快照。
// ============================================================================

/** 复刻 index.tsx 挂载点：草案经 storePendingScheduleDraft 覆盖时卡片不重挂（无 key）。 */
let panelStore: ((draft: PendingScheduleDraft) => boolean) | undefined;
function SchedulePanel() {
  const schedule = useScheduleDraft('session-1');
  panelStore = schedule.storePendingScheduleDraft;
  if (!schedule.pendingScheduleDraft) return null;
  return (
    <ScheduleConfirmCard
      draft={schedule.pendingScheduleDraft}
      confirming={false}
      onConfirm={() => undefined}
      onDismiss={() => undefined}
      onDraftChange={schedule.storePendingScheduleDraft}
    />
  );
}

/** 「监听哪个群」行的值单元格（行 div 下内层 div 里的值 span）。 */
function groupRowValue(): string {
  return document.querySelector('[data-schedule-row="group"] div span')?.textContent ?? '';
}

const eventRowLabels = {
  what: '检查什么', when: '什么时候', notifyWhen: '什么变化值得通知', result: '结果送到哪里',
  fallbackWhat: '按任务描述执行', fallbackNotifyWhen: '完成时通知', reviewInbox: '自动化审核收件箱',
};

describe('event confirm card — rework r1 regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChannelCatalog();
    panelStore = undefined;
  });

  it('Important 1: 草案被同会话再次 /schedule 替换时，卡内编辑态随草案身份重置', async () => {
    render(<SchedulePanel />);

    await act(async () => {
      panelStore?.(makeEventPending());
    });

    // 第一份草案：选账号 → 按名预选发布群，预算改 2（制造有编辑态的现场），确认可用。
    fireEvent.change(await screen.findByLabelText(/^触发账号/), { target: { value: feishuAccount.id } });
    const chatSelect = await screen.findByLabelText('限定会话 / 群（可选）') as HTMLSelectElement;
    await waitFor(() => expect(chatSelect.value).toBe('oc_release'));
    fireEvent.change(screen.getByLabelText(/^单次预算上限/), { target: { value: '2' } });
    await waitFor(() => expect(confirmButton().disabled).toBe(false));

    // 第二次 /schedule：storePendingScheduleDraft 直接覆盖草案，卡片不重挂、不重放挂载态。
    await act(async () => {
      panelStore?.(makeEventPending({ description: '再盯一次发布群' }));
    });

    // 字段区回到新草案初始态：账号未选、预算回预填 0.5、确认重新禁用。
    const accountSelect = screen.getByLabelText(/^触发账号/) as HTMLSelectElement;
    expect(accountSelect.value).toBe('');
    expect((screen.getByLabelText(/^单次预算上限/) as HTMLInputElement).value).toBe('0.5');
    expect(confirmButton().disabled).toBe(true);
    // 摘要行回到新草案的原话提示（无绑定可陈述）。
    expect(groupRowValue()).toBe('发布群');

    // 新草案重新选账号：预选已为本群名尝试过不再弹回 → 任意会话；旧草案的
    // chatId/accountId 没有残进新草案，确认在合法绑定（任意会话）下可用。
    fireEvent.change(accountSelect, { target: { value: feishuAccount.id } });
    const chatSelectAfterReplace = await screen.findByLabelText('限定会话 / 群（可选）') as HTMLSelectElement;
    expect(chatSelectAfterReplace.value).toBe('');
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
  });

  it('Important 2: 用户把群改回「任意会话」后，按名预选不会把选择弹回同名群', async () => {
    render(<DraftHost initial={makeEventPending()} />);

    fireEvent.change(await screen.findByLabelText(/^触发账号/), { target: { value: feishuAccount.id } });
    const chatSelect = await screen.findByLabelText('限定会话 / 群（可选）') as HTMLSelectElement;
    await waitFor(() => expect(chatSelect.value).toBe('oc_release'));

    fireEvent.change(chatSelect, { target: { value: '' } });
    await act(async () => {});
    expect(chatSelect.value).toBe('');
    // 任意会话是合法绑定：账号已选、预算为正 → 确认可用，不被预选搅回。
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
  });

  it('Important 3: 卡内改选群 / 改回任意会话后，「监听哪个群」行摘要跟着实际绑定走', async () => {
    render(<DraftHost initial={makeEventPending()} />);

    fireEvent.change(await screen.findByLabelText(/^触发账号/), { target: { value: feishuAccount.id } });
    const chatSelect = await screen.findByLabelText('限定会话 / 群（可选）') as HTMLSelectElement;
    await waitFor(() => expect(chatSelect.value).toBe('oc_release'));
    // 预选后行值 = 选中的群（目录名），与原话提示同名是巧合，值来自绑定。
    await waitFor(() => expect(groupRowValue()).toBe('发布群'));

    // 改选闲聊群：行摘要必须跟着换，不能还写原话「发布群」。
    fireEvent.change(chatSelect, { target: { value: 'oc_random' } });
    await waitFor(() => expect(groupRowValue()).toBe('闲聊群'));

    // 改回「任意会话」：行摘要陈述 账号名 · 任意会话（账号名来自目录，不是内部 id）。
    fireEvent.change(chatSelect, { target: { value: '' } });
    await waitFor(() => expect(groupRowValue())
      .toBe(`工作飞书 · ${cronCenterZh.cronCenter.eventConfirmGroupAnyChat}`));
  });

  it('Important 3（纯函数侧）: buildScheduleConfirmRows 的群行值随绑定与显示名走', () => {
    const eventLabels = {
      group: cronCenterZh.cronCenter.eventConfirmGroup,
      groupFallback: cronCenterZh.cronCenter.eventConfirmGroupFallback,
      groupAnyChat: cronCenterZh.cronCenter.eventConfirmGroupAnyChat,
      budget: cronCenterZh.cronCenter.eventBudgetLabel,
    };
    const binding = (accountId: string, chatId?: string) => ({
      type: 'event',
      source: 'channel',
      eventName: 'message',
      accountId,
      ...(chatId ? { chatId } : {}),
    }) as CreateCronJobInput['schedule'];
    const rowsOf = (draft: PendingScheduleDraft) => buildScheduleConfirmRows(draft, eventRowLabels, 'zh', eventLabels);
    const groupOf = (draft: PendingScheduleDraft) => rowsOf(draft).find((row) => row.key === 'group')?.value;

    // 有绑定 + 目录名：陈述实际选中的群，不引用原话提示。
    expect(groupOf({
      ...makeEventPending(),
      input: { ...makeEventPending().input, schedule: binding('account-feishu', 'oc_random') },
      eventBindingNames: { accountName: '工作飞书', chatName: '闲聊群' },
    })).toBe('闲聊群');
    // 任意会话：账号名（目录名，非内部 id）· 任意会话。
    expect(groupOf({
      ...makeEventPending(),
      input: { ...makeEventPending().input, schedule: binding('account-feishu') },
      eventBindingNames: { accountName: '工作飞书' },
    })).toBe(`工作飞书 · ${cronCenterZh.cronCenter.eventConfirmGroupAnyChat}`);
    // 有绑定但目录名缺席（手输/模型带 id）：回落 id 陈述，不假装是原话群名。
    expect(groupOf({
      ...makeEventPending(),
      input: { ...makeEventPending().input, schedule: binding('account-feishu', 'oc_random') },
    })).toBe('oc_random');
    // 无绑定：原话提示兜底；无提示再落「还没选」文案。
    expect(groupOf(makeEventPending())).toBe('发布群');
    expect(groupOf({ ...makeEventPending(), eventGroupName: undefined }))
      .toBe(cronCenterZh.cronCenter.eventConfirmGroupFallback);
  });
});
