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
import { buildScheduleConfirmRows } from '../../../src/renderer/components/features/chat/ChatInput/scheduleConfirm';
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
});
