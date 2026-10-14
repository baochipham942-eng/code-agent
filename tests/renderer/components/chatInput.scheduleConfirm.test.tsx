// @vitest-environment jsdom

import React from 'react';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateCronJobInput } from '../../../src/renderer/services/cronClient';

const mocks = vi.hoisted(() => ({
  generateFromPrompt: vi.fn(),
  createJob: vi.fn(),
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    generateFromPrompt: mocks.generateFromPrompt,
    createJob: mocks.createJob,
  },
}));
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
import { buildScheduleConfirmRows, normalizeScheduleDraft } from '../../../src/renderer/components/features/chat/ChatInput/scheduleConfirm';
import { useScheduleDraft } from '../../../src/renderer/components/features/chat/ChatInput/useScheduleDraft';
import type { PendingScheduleDraft } from '../../../src/renderer/components/features/chat/ChatInput/useScheduleDraft';

const generatedDraft = {
  name: '每日邮件巡检',
  description: '每天查看邮件并汇总重点',
  enabled: true,
  scheduleType: 'every',
  schedule: { type: 'every', interval: 1, unit: 'days' },
  action: { type: 'agent', agentType: 'default', prompt: '查看邮件并汇总重点' },
  restatement: { what: '检查新邮件和需要跟进的事项', notifyWhen: '发现高优先级或需要回复的邮件' },
};

const createdJob = {
  ...generatedDraft,
  id: 'job-1',
  createdAt: 1,
  updatedAt: 1,
  nextRunAt: 2,
};

const rowLabels = {
  what: '检查什么',
  when: '什么时候',
  notifyWhen: '什么变化值得通知',
  result: '结果送到哪里',
  fallbackWhat: '按任务描述执行并整理结果',
  fallbackNotifyWhen: '任务完成或发现异常时通知',
  reviewInbox: '自动化审核收件箱',
};

const rowInput = {
  name: '邮件巡检',
  description: '每天查看邮件并汇总重点',
  enabled: true,
  scheduleType: 'every',
  schedule: { type: 'every', interval: 1, unit: 'days' },
  action: { type: 'agent', agentType: 'default', prompt: '查看邮件并汇总重点' },
} as CreateCronJobInput;

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

describe('scheduled task confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateFromPrompt.mockResolvedValue(generatedDraft);
    mocks.createJob.mockResolvedValue(createdJob);
  });

  it('does not create a job until the confirmation action is called', async () => {
    const { result } = renderHook(() => useScheduleSubmitHarness());

    await act(async () => {
      await result.current.runScheduleCreation('每天早上帮我看邮件');
    });

    expect(result.current.pendingScheduleDraft?.restatement).toEqual(generatedDraft.restatement);
    expect(mocks.createJob).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.confirmScheduleCreation();
    });

    expect(mocks.createJob).toHaveBeenCalledTimes(1);
    expect(mocks.createJob.mock.calls[0]?.[0]).not.toHaveProperty('restatement');
    expect(mocks.toast.success).toHaveBeenCalledTimes(1);
  });

  it('confirm failure toast stays readable and does not leak the internal error message', async () => {
    mocks.createJob.mockRejectedValueOnce(new Error('Cannot read properties of undefined (reading type)'));
    const { result } = renderHook(() => useScheduleSubmitHarness());

    await act(async () => {
      await result.current.runScheduleCreation('每天早上帮我看邮件');
    });
    await act(async () => {
      await result.current.confirmScheduleCreation();
    });

    expect(mocks.toast.error).toHaveBeenCalledTimes(1);
    expect(mocks.toast.error).toHaveBeenCalledWith('确认创建未完成，任务没有创建。可直接重试确认，或取消后重新发起');
  });

  it('generate failure toast stays readable and does not leak the internal error message', async () => {
    mocks.generateFromPrompt.mockRejectedValueOnce(new Error('Cannot read properties of undefined (reading type)'));
    const { result } = renderHook(() => useScheduleSubmitHarness());

    await act(async () => {
      await result.current.runScheduleCreation('每天早上帮我看邮件');
    });

    expect(result.current.pendingScheduleDraft).toBeNull();
    expect(mocks.createJob).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalledTimes(1);
    expect(mocks.toast.error).toHaveBeenCalledWith('创建定时任务失败：草案没有生成成功，请稍后重试');
  });

  it('rejects a draft without action: no card, error toast instead', async () => {
    mocks.generateFromPrompt.mockResolvedValueOnce({ ...generatedDraft, action: undefined });
    const { result } = renderHook(() => useScheduleSubmitHarness());

    await act(async () => {
      await result.current.runScheduleCreation('每天早上帮我看邮件');
    });

    expect(result.current.pendingScheduleDraft).toBeNull();
    expect(mocks.createJob).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalledWith('创建定时任务失败：AI 返回的定时任务草案格式异常，请重试');
  });

  it('rejects a draft without schedule: no card, error toast instead', async () => {
    mocks.generateFromPrompt.mockResolvedValueOnce({ ...generatedDraft, schedule: undefined });
    const { result } = renderHook(() => useScheduleSubmitHarness());

    await act(async () => {
      await result.current.runScheduleCreation('每天早上帮我看邮件');
    });

    expect(result.current.pendingScheduleDraft).toBeNull();
    expect(mocks.createJob).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalledWith('创建定时任务失败：AI 返回的定时任务草案格式异常，请重试');
  });

  it('rejects a draft whose schedule has no string type: no card, error toast instead', async () => {
    mocks.generateFromPrompt.mockResolvedValueOnce({ ...generatedDraft, schedule: { interval: 1, unit: 'days' } });
    const { result } = renderHook(() => useScheduleSubmitHarness());

    await act(async () => {
      await result.current.runScheduleCreation('每天早上帮我看邮件');
    });

    expect(result.current.pendingScheduleDraft).toBeNull();
    expect(mocks.createJob).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalledWith('创建定时任务失败：AI 返回的定时任务草案格式异常，请重试');
  });

  it('rejects an agent action without prompt (review case): no card, error toast instead', async () => {
    mocks.generateFromPrompt.mockResolvedValueOnce({
      schedule: { type: 'every', interval: 1, unit: 'days' },
      action: { type: 'agent' },
    });
    const { result } = renderHook(() => useScheduleSubmitHarness());

    await act(async () => {
      await result.current.runScheduleCreation('每天早上帮我看邮件');
    });

    expect(result.current.pendingScheduleDraft).toBeNull();
    expect(mocks.createJob).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalledWith('创建定时任务失败：AI 返回的定时任务草案格式异常，请重试');
  });

  it('rejects a shell action without command: no card, error toast instead', async () => {
    mocks.generateFromPrompt.mockResolvedValueOnce({
      schedule: { type: 'every', interval: 1, unit: 'days' },
      action: { type: 'shell' },
    });
    const { result } = renderHook(() => useScheduleSubmitHarness());

    await act(async () => {
      await result.current.runScheduleCreation('每天早上帮我看邮件');
    });

    expect(result.current.pendingScheduleDraft).toBeNull();
    expect(mocks.createJob).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalledWith('创建定时任务失败：AI 返回的定时任务草案格式异常，请重试');
  });

  it('cancel discards the draft without creating, notifying, or showing success', async () => {
    const { result } = renderHook(() => useScheduleSubmitHarness());

    await act(async () => {
      await result.current.runScheduleCreation('每天早上帮我看邮件');
      result.current.discardPendingScheduleDraft();
    });

    expect(result.current.pendingScheduleDraft).toBeNull();
    expect(mocks.createJob).not.toHaveBeenCalled();
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it('sending a new message discards the pending draft before the message is sent', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => {
      const schedule = useScheduleDraft('session-1');
      const submit = useChatInputSubmit(makeParams({ value: '发一条新消息', onSend, scheduleDraft: schedule }));
      return { ...schedule, ...submit };
    });

    await act(async () => {
      await result.current.runScheduleCreation('每天早上帮我看邮件');
    });
    await act(async () => {
      await result.current.handleSubmit({ preventDefault: vi.fn() } as never);
    });

    expect(result.current.pendingScheduleDraft).toBeNull();
    expect(mocks.createJob).not.toHaveBeenCalled();
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('switching sessions clears the pending draft', () => {
    const { result, rerender } = renderHook(
      ({ sessionId }) => useScheduleDraft(sessionId),
      { initialProps: { sessionId: 'session-1' } },
    );

    act(() => {
      result.current.storePendingScheduleDraft({
        input: rowInput,
        description: '每天早上帮我看邮件',
        sourceSessionId: 'session-1',
      });
    });
    expect(result.current.pendingScheduleDraft).not.toBeNull();

    rerender({ sessionId: 'session-2' });
    expect(result.current.pendingScheduleDraft).toBeNull();
  });
});

// ①（N-CRON-RESTATE-HUMAN-WHEN）：when 行按 UI 语言走 cronHumanize 人话文案；
// 复杂表达式带「自定义时间 / Custom schedule」前缀，at 按语言本地化日期。
describe('buildScheduleConfirmRows — when 行按 UI 语言说人话', () => {
  const draftOf = (schedule: CreateCronJobInput['schedule']) => ({ input: { ...rowInput, schedule } });
  const whenRow = (schedule: CreateCronJobInput['schedule'], lang: 'zh' | 'en') =>
    buildScheduleConfirmRows(draftOf(schedule), rowLabels, lang).find((row) => row.key === 'when')?.value;

  it.each([
    { lang: 'zh', schedule: { type: 'cron', expression: '17 8 * * *' }, expected: '每天 08:17' },
    { lang: 'en', schedule: { type: 'cron', expression: '17 8 * * *' }, expected: 'Daily at 08:17' },
    { lang: 'zh', schedule: { type: 'cron', expression: '0 9 * * 1' }, expected: '每周一 09:00' },
    { lang: 'en', schedule: { type: 'cron', expression: '0 9 * * 1' }, expected: 'Weekly on Monday at 09:00' },
    { lang: 'zh', schedule: { type: 'cron', expression: '30 8 * * 1-5' }, expected: '工作日 08:30' },
    { lang: 'en', schedule: { type: 'cron', expression: '30 8 * * 1-5' }, expected: 'Weekdays at 08:30' },
    { lang: 'zh', schedule: { type: 'every', interval: 3, unit: 'hours' }, expected: '每 3 小时' },
    { lang: 'en', schedule: { type: 'every', interval: 3, unit: 'hours' }, expected: 'Every 3 hours' },
    { lang: 'zh', schedule: { type: 'every', interval: 1, unit: 'days' }, expected: '每 1 天' },
    { lang: 'en', schedule: { type: 'every', interval: 1, unit: 'days' }, expected: 'Every day' },
    { lang: 'zh', schedule: { type: 'cron', expression: '7 3 * * 2-4' }, expected: '自定义时间 · 7 3 * * 2-4' },
    { lang: 'en', schedule: { type: 'cron', expression: '7 3 * * 2-4' }, expected: 'Custom schedule · 7 3 * * 2-4' },
  ])('cronHumanize 人话：$expected（$lang）', ({ schedule, lang, expected }) => {
    expect(whenRow(schedule as CreateCronJobInput['schedule'], lang as 'zh' | 'en')).toBe(expected);
  });

  it('at 按语言本地化日期（zh/en 形状不同）；解析不了的 datetime 给一次性/Once', () => {
    const ts = Date.UTC(2026, 11, 25, 1, 30);
    const zhLabel = whenRow({ type: 'at', datetime: ts }, 'zh');
    const enLabel = whenRow({ type: 'at', datetime: ts }, 'en');
    // 数字随运行机时区漂，只锁形状与「两种语言确实不同」
    expect(zhLabel).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
    expect(enLabel).toMatch(/^\d{2}\/\d{2}, \d{2}:\d{2} (AM|PM)$/);
    expect(zhLabel).not.toBe(enLabel);
    expect(whenRow({ type: 'at', datetime: 'garbage' }, 'zh')).toBe('一次性');
    expect(whenRow({ type: 'at', datetime: 'garbage' }, 'en')).toBe('Once');
  });

  it('缺省 lang 保持 zh（既有调用方零扰动）', () => {
    expect(whenRow({ type: 'cron', expression: '17 8 * * *' }, undefined as never)).toBe('每天 08:17');
  });
});

describe('buildScheduleConfirmRows', () => {
  it('builds the four plain-language rows from the draft restatement', () => {
    expect(buildScheduleConfirmRows({
      input: rowInput,
      restatement: { what: '检查新邮件和需要跟进的事项', notifyWhen: '发现高优先级或需要回复的邮件' },
    }, rowLabels)).toEqual([
      { key: 'what', label: '检查什么', value: '检查新邮件和需要跟进的事项' },
      { key: 'when', label: '什么时候', value: '每 1 天' },
      { key: 'notifyWhen', label: '什么变化值得通知', value: '发现高优先级或需要回复的邮件' },
      { key: 'result', label: '结果送到哪里', value: '自动化审核收件箱' },
    ]);
  });

  it('falls back to the job name and review inbox when optional fields are absent', () => {
    const rows = buildScheduleConfirmRows({ input: rowInput }, rowLabels);
    expect(rows[0]?.value).toBe('邮件巡检');
    expect(rows[2]?.value).toBe('任务完成或发现异常时通知');
    expect(rows[3]?.value).toBe('自动化审核收件箱');
  });

  it('uses an explicit result channel when the draft provides one', () => {
    const rows = buildScheduleConfirmRows({ input: { ...rowInput, resultChannel: 'feishu:ops' } }, rowLabels);
    expect(rows[3]?.value).toBe('feishu:ops');
  });
});

describe('untrusted cron draft fields never crash the confirm card', () => {
  const W = '检查新邮件和需要跟进的事项';
  const N = '发现高优先级或需要回复的邮件';
  const WHEN = '每 1 天';
  const INBOX = '自动化审核收件箱';
  const FN = '任务完成或发现异常时通知';

  // 走真实链路：generateFromPrompt → runScheduleCreation 存草稿 → 确认卡渲染时调 buildScheduleConfirmRows。
  async function rowsAfterStoring(raw: unknown): Promise<readonly string[] | null> {
    mocks.generateFromPrompt.mockResolvedValueOnce(raw);
    const { result } = renderHook(() => useScheduleSubmitHarness());
    await act(async () => {
      await result.current.runScheduleCreation('每天早上帮我看邮件');
    });
    const pending = result.current.pendingScheduleDraft;
    if (!pending) return null;
    return buildScheduleConfirmRows(pending, rowLabels).map((row) => row.value);
  }

  it.each([
    ['name missing', { ...generatedDraft, restatement: undefined, name: undefined }, ['查看邮件并汇总重点', WHEN, FN, INBOX]],
    ['name wrong type', { ...generatedDraft, restatement: undefined, name: 42 }, ['查看邮件并汇总重点', WHEN, FN, INBOX]],
    ['description wrong type', { ...generatedDraft, description: ['汇总'] }, [W, WHEN, N, INBOX]],
    ['resultChannel wrong type', { ...generatedDraft, resultChannel: 99 }, [W, WHEN, N, INBOX]],
    ['restatement.what wrong type', { ...generatedDraft, restatement: { what: 5, notifyWhen: '有新邮件' } }, ['每日邮件巡检', WHEN, FN, INBOX]],
    ['restatement.notifyWhen wrong type', { ...generatedDraft, restatement: { what: '检查新邮件', notifyWhen: [] } }, ['每日邮件巡检', WHEN, FN, INBOX]],
    ['restatement wrong type', { ...generatedDraft, restatement: 'oops' }, ['每日邮件巡检', WHEN, FN, INBOX]],
    ['cron timezone wrong type humanizes expression', { ...generatedDraft, schedule: { type: 'cron', expression: '17 9 * * *', timezone: 5 } }, [W, '每天 09:17', N, INBOX]],
    ['webhook without url falls back to description', {
      name: undefined,
      description: '推送结果',
      schedule: { type: 'every', interval: 1, unit: 'days' },
      action: { type: 'webhook' },
    }, ['推送结果', WHEN, INBOX]],
  ])('renders fallback copy when %s', async (_label, raw, expected) => {
    const rows = await rowsAfterStoring(raw);
    expect(rows).toEqual(expected);
  });

  // 缺 schedule / schedule 不是带字符串 type 的对象 / 按 type 的必需字段缺失：
  // 与缺 action 同等处理，草案判无效不出卡（rowsAfterStoring → null），走「草案格式异常」错误提示。
  it.each([
    ['schedule missing', { ...generatedDraft, schedule: undefined }],
    ['schedule.type wrong type', { ...generatedDraft, schedule: { type: 9, interval: 1, unit: 'days' } }],
    ['every unit invalid', { ...generatedDraft, schedule: { type: 'every', interval: 1, unit: 'weeks' } }],
    ['every interval wrong type', { ...generatedDraft, schedule: { type: 'every', interval: '1', unit: 'days' } }],
    ['cron expression missing', { ...generatedDraft, schedule: { type: 'cron', timezone: 'Asia/Shanghai' } }],
    ['at datetime wrong type', { ...generatedDraft, schedule: { type: 'at', datetime: null } }],
  ])('rejects a draft when %s: no card rows', async (_label, raw) => {
    const rows = await rowsAfterStoring(raw);
    expect(rows).toBeNull();
  });

  it('buildScheduleConfirmRows itself never throws on fully garbage input', () => {
    const rows = buildScheduleConfirmRows({
      input: { name: 7, description: [], resultChannel: {}, schedule: null, action: null } as unknown as CreateCronJobInput,
      restatement: 5 as never,
    }, rowLabels);
    // when 行不再有「按配置」兜底：真实链路里无效 schedule 在规范化阶段就被拒，
    // 这里只保证纯函数对垃圾输入不抛错（when 留空，生产不可达）。
    // notifyWhen 行只对 agent 动作出（判据无法生效就不给假口子），garbage action=null → 不出。
    expect(rows.map((row) => row.value)).toEqual(['按任务描述执行并整理结果', '', '自动化审核收件箱']);
  });
});

describe('normalizeScheduleDraft', () => {
  it.each([
    ['agent without prompt (review case)', { action: { type: 'agent' } }],
    ['agent prompt wrong type', { schedule: { type: 'cron', expression: '17 9 * * *' }, action: { type: 'agent', prompt: 7 } }],
    ['shell without command', { action: { type: 'shell' } }],
    ['unknown action type', { schedule: { type: 'every', interval: 1, unit: 'days' }, action: { type: 'weird' } }],
    ['action.type wrong type', { schedule: { type: 'every', interval: 1, unit: 'days' }, action: { type: 42 } }],
    ['action wrong type', { action: 'noop' }],
    ['schedule present but action missing', { schedule: { type: 'at', datetime: '2026-01-01' } }],
    ['schedule missing', { ...generatedDraft, schedule: undefined }],
    ['schedule without type', { ...generatedDraft, schedule: { interval: 1, unit: 'days' } }],
    ['schedule wrong type', { ...generatedDraft, schedule: 'daily' }],
    ['every unit invalid', { ...generatedDraft, schedule: { type: 'every', interval: 1, unit: 'weeks' } }],
    ['draft not an object', 'nope'],
    ['draft is an array', [{ action: { type: 'agent', prompt: 'x' } }]],
  ])('returns null for %s', (_label, raw) => {
    expect(normalizeScheduleDraft(raw)).toBeNull();
  });

  it('keeps a fully valid draft and trims display strings', () => {
    const normalized = normalizeScheduleDraft({ ...generatedDraft, name: '  每日邮件巡检  ', resultChannel: ' feishu:ops ' });
    expect(normalized?.input.name).toBe('每日邮件巡检');
    expect(normalized?.input.resultChannel).toBe('feishu:ops');
    expect(normalized?.input.schedule).toEqual(generatedDraft.schedule);
    expect(normalized?.restatement).toEqual(generatedDraft.restatement);
  });

  it('drops non-string display fields instead of keeping them', () => {
    const normalized = normalizeScheduleDraft({ ...generatedDraft, name: 42, description: [], resultChannel: false });
    expect(normalized?.input.name).toBeUndefined();
    expect(normalized?.input.description).toBeUndefined();
    expect(normalized?.input.resultChannel).toBeUndefined();
    expect(normalized?.input.action).toEqual(generatedDraft.action);
  });
});

describe('ScheduleConfirmCard', () => {
  it('renders four restated rows and invokes confirm or cancel', () => {
    const draft: PendingScheduleDraft = {
      input: rowInput,
      restatement: { what: '检查新邮件和需要跟进的事项', notifyWhen: '发现高优先级或需要回复的邮件' },
      description: '每天早上帮我看邮件',
      sourceSessionId: 'session-1',
    };
    const onConfirm = vi.fn();
    const onDismiss = vi.fn();
    render(<ScheduleConfirmCard draft={draft} confirming={false} onConfirm={onConfirm} onDismiss={onDismiss} />);

    expect(screen.getByText('检查什么')).toBeTruthy();
    expect(screen.getByText('什么时候')).toBeTruthy();
    expect(screen.getByText('什么变化值得通知')).toBeTruthy();
    expect(screen.getByText('结果送到哪里')).toBeTruthy();
    expect(screen.getByText('检查新邮件和需要跟进的事项')).toBeTruthy();
    expect(screen.getByText('自动化审核收件箱')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '确认创建' }));
    fireEvent.click(screen.getAllByRole('button', { name: '取消' })[1]!);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders fallback copy for a degraded draft without crashing (notifyWhen row only for agent actions)', () => {
    const draft: PendingScheduleDraft = {
      input: {
        schedule: { type: 'every', interval: 1, unit: 'days' },
        action: { type: 'shell', command: 'backup.sh' },
      } as unknown as CreateCronJobInput,
      description: '每天备份数据库',
      sourceSessionId: 'session-1',
    };
    render(<ScheduleConfirmCard draft={draft} confirming={false} onConfirm={vi.fn()} onDismiss={vi.fn()} />);

    expect(screen.getByText('backup.sh')).toBeTruthy();
    expect(screen.getByText('每 1 天')).toBeTruthy();
    // shell 动作没有可生效的通知判据（prompt 注入与通知门都在 agent 执行链上）：
    // notifyWhen 整行不出，不给「看起来可配置」的假口子。
    expect(screen.queryByText('任务完成或发现异常时通知')).toBeNull();
    expect(screen.getByText('自动化审核收件箱')).toBeTruthy();
  });
});

// ②（N-CRON-RESTATE-HUMAN-WHEN）：确认时把（可能已在卡内编辑过的）通知判据写进
// action.notifyWhen；空判据不写字段 = 「每次都通知」的旧行为、prompt 字节不变。
describe('confirmScheduleCreation — notifyWhen 落进任务', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateFromPrompt.mockResolvedValue(generatedDraft);
    mocks.createJob.mockResolvedValue(createdJob);
  });

  it('restatement.notifyWhen 写进 action.notifyWhen（与 sourceSessionId 合并共存）', async () => {
    const { result } = renderHook(() => useScheduleSubmitHarness());

    await act(async () => {
      await result.current.runScheduleCreation('每天早上帮我看邮件');
    });
    await act(async () => {
      await result.current.confirmScheduleCreation();
    });

    expect(mocks.createJob).toHaveBeenCalledTimes(1);
    expect(mocks.createJob.mock.calls[0]?.[0].action).toMatchObject({
      type: 'agent',
      notifyWhen: '发现高优先级或需要回复的邮件',
      context: { sourceSessionId: 'session-1' },
    });
  });

  it('restatement 缺席 → action 不带 notifyWhen 字段（旧行为，零扰动）', async () => {
    mocks.generateFromPrompt.mockResolvedValueOnce({ ...generatedDraft, restatement: undefined });
    const { result } = renderHook(() => useScheduleSubmitHarness());

    await act(async () => {
      await result.current.runScheduleCreation('每天早上帮我看邮件');
    });
    await act(async () => {
      await result.current.confirmScheduleCreation();
    });

    expect(mocks.createJob.mock.calls[0]?.[0].action).not.toHaveProperty('notifyWhen');
  });

  it('空白判据同样不写字段（空 = 每次都通知）', async () => {
    mocks.generateFromPrompt.mockResolvedValueOnce({
      ...generatedDraft,
      restatement: { what: '检查新邮件', notifyWhen: '   ' },
    });
    const { result } = renderHook(() => useScheduleSubmitHarness());

    await act(async () => {
      await result.current.runScheduleCreation('每天早上帮我看邮件');
    });
    await act(async () => {
      await result.current.confirmScheduleCreation();
    });

    expect(mocks.createJob.mock.calls[0]?.[0].action).not.toHaveProperty('notifyWhen');
  });
});

// ③（N-CRON-RESTATE-HUMAN-WHEN）：卡内可改时间（compileSimpleSchedule 五档）与通知判据。
describe('ScheduleConfirmCard — 卡内编辑', () => {
  function agentDraft(overrides: Partial<PendingScheduleDraft['input']> = {}): PendingScheduleDraft {
    return {
      input: {
        ...rowInput,
        schedule: { type: 'cron', expression: '17 8 * * *' },
        ...overrides,
      } as CreateCronJobInput,
      restatement: { what: '检查新邮件和需要跟进的事项', notifyWhen: '发现高优先级或需要回复的邮件' },
      description: '每天早上帮我看邮件',
      sourceSessionId: 'session-1',
    };
  }

  it('when 行：改频率+时间 → compileSimpleSchedule 编译进草案（schedule 与 scheduleType 同步）', () => {
    const onDraftChange = vi.fn();
    const { container } = render(
      <ScheduleConfirmCard draft={agentDraft()} confirming={false} onConfirm={vi.fn()} onDismiss={vi.fn()} onDraftChange={onDraftChange} />,
    );

    fireEvent.click(screen.getByRole('button', { name: '编辑 什么时候' }));
    fireEvent.change(screen.getByLabelText('什么时候'), { target: { value: 'daily' } });
    fireEvent.change(screen.getByLabelText('时间'), { target: { value: '08:30' } });
    fireEvent.click(screen.getByText('保存'));

    expect(onDraftChange).toHaveBeenCalledTimes(1);
    const next = onDraftChange.mock.calls[0]?.[0] as PendingScheduleDraft;
    expect(next.input.schedule).toEqual({ type: 'cron', expression: '30 8 * * *' });
    expect(next.input.scheduleType).toBe('cron');
    // 只动调度，其余字段原样带回
    expect(next.restatement).toEqual(agentDraft().restatement);
  });

  it('when 行：每周档带星期选择；每小时档编译成 every hours', () => {
    const onDraftChange = vi.fn();
    render(
      <ScheduleConfirmCard draft={agentDraft()} confirming={false} onConfirm={vi.fn()} onDismiss={vi.fn()} onDraftChange={onDraftChange} />,
    );

    fireEvent.click(screen.getByRole('button', { name: '编辑 什么时候' }));
    fireEvent.change(screen.getByLabelText('什么时候'), { target: { value: 'weekly' } });
    fireEvent.change(screen.getByLabelText('时间'), { target: { value: '09:00' } });
    fireEvent.change(screen.getByLabelText('星期几'), { target: { value: '3' } });
    fireEvent.click(screen.getByText('保存'));
    expect((onDraftChange.mock.calls[0]?.[0] as PendingScheduleDraft).input.schedule)
      .toEqual({ type: 'cron', expression: '0 9 * * 3' });

    onDraftChange.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '编辑 什么时候' }));
    fireEvent.change(screen.getByLabelText('什么时候'), { target: { value: 'hourly' } });
    fireEvent.change(screen.getByLabelText('间隔（小时）'), { target: { value: '4' } });
    fireEvent.click(screen.getByText('保存'));
    expect((onDraftChange.mock.calls[0]?.[0] as PendingScheduleDraft).input.schedule)
      .toEqual({ type: 'every', interval: 4, unit: 'hours' });
  });

  it('when 行：复杂表达式保持原样（keep 档），选了频率才可应用', () => {
    const onDraftChange = vi.fn();
    const { container } = render(
      <ScheduleConfirmCard
        draft={agentDraft({ schedule: { type: 'cron', expression: '7 3 * * 2-4' } })}
        confirming={false}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
        onDraftChange={onDraftChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '编辑 什么时候' }));
    const apply = container.querySelector('[data-schedule-when-apply]') as HTMLButtonElement;
    expect(apply.hasAttribute('disabled')).toBe(true);
    expect(screen.getByLabelText('什么时候')).toHaveProperty('value', 'keep');

    // 选「每天」后输入出现、应用可用，应用即覆盖复杂表达式
    fireEvent.change(screen.getByLabelText('什么时候'), { target: { value: 'daily' } });
    fireEvent.change(screen.getByLabelText('时间'), { target: { value: '09:15' } });
    fireEvent.click(screen.getByText('保存'));
    expect((onDraftChange.mock.calls[0]?.[0] as PendingScheduleDraft).input.schedule)
      .toEqual({ type: 'cron', expression: '15 9 * * *' });
  });

  it('when 行：取消编辑不改草案', () => {
    const onDraftChange = vi.fn();
    render(
      <ScheduleConfirmCard draft={agentDraft()} confirming={false} onConfirm={vi.fn()} onDismiss={vi.fn()} onDraftChange={onDraftChange} />,
    );

    fireEvent.click(screen.getByRole('button', { name: '编辑 什么时候' }));
    fireEvent.change(screen.getByLabelText('时间'), { target: { value: '23:59' } });
    fireEvent.click(screen.getByText('不改了'));
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it('notify 行：判据可编辑，maxLength 与 urgencyCriteria 同上限；保存写回 restatement', () => {
    const onDraftChange = vi.fn();
    const { container } = render(
      <ScheduleConfirmCard draft={agentDraft()} confirming={false} onConfirm={vi.fn()} onDismiss={vi.fn()} onDraftChange={onDraftChange} />,
    );

    fireEvent.click(screen.getByRole('button', { name: '编辑 什么变化值得通知' }));
    const input = container.querySelector('[data-schedule-notify-input]') as HTMLInputElement;
    expect(input.maxLength).toBe(200); // CRON_URGENCY_CRITERIA.MAX_CHARS
    fireEvent.change(input, { target: { value: '只有生产事故才通知我' } });
    fireEvent.click(screen.getByText('保存'));

    expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({
      restatement: { what: '检查新邮件和需要跟进的事项', notifyWhen: '只有生产事故才通知我' },
    }));
  });

  it('notify 行：草案没有 restatement 时编辑，what 行展示值兜底进合成 restatement', () => {
    const onDraftChange = vi.fn();
    render(
      <ScheduleConfirmCard
        draft={{ ...agentDraft(), restatement: undefined }}
        confirming={false}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
        onDraftChange={onDraftChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '编辑 什么变化值得通知' }));
    const input = screen.getByLabelText('什么变化值得通知');
    expect(input).toHaveProperty('value', '');
    fireEvent.change(input, { target: { value: '有升级故障才通知' } });
    fireEvent.click(screen.getByText('保存'));

    expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({
      restatement: { what: '邮件巡检', notifyWhen: '有升级故障才通知' },
    }));
  });

  it('未传 onDraftChange 时不出编辑钮（只读卡片，旧调用方零扰动）', () => {
    render(<ScheduleConfirmCard draft={agentDraft()} confirming={false} onConfirm={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '编辑 什么时候' })).toBeNull();
    expect(screen.queryByRole('button', { name: '编辑 什么变化值得通知' })).toBeNull();
  });
});
