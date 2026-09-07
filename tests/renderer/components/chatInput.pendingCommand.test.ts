// @vitest-environment jsdom
// ============================================================================
// 特色命令 chip（任务 17）：pendingCommand 选中 chip 化 + 提交时拼回前缀走原解析
// ----------------------------------------------------------------------------
// 钉四件事：
// 1. slash 面板选中 /goal 这类带参命令 → 挂 chip、清触发文本（见 useChatInputSlashCommands 测试）；
// 2. 提交时 `/${id} ` 前缀拼回，行为与手打「/goal xxx」逐字一致（goal 走确认卡 / workflow 走普通发送）；
// 3. chip 在发送后被清掉，/loop 缺参这类「文本还在」的失败路径 chip 也保留；
// 4. 发送失败 restoreDraft 时 chip 随草稿一起还回来。
// ============================================================================

import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({ invoke: mocks.invoke }));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: mocks.toast }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

import { useChatInputSubmit, type UseChatInputSubmitParams } from '../../../src/renderer/components/features/chat/ChatInput/useChatInputSubmit';
import { applyPendingCommandPrefix } from '../../../src/renderer/components/features/chat/ChatInput/pendingCommand';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';

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

async function submit(params: UseChatInputSubmitParams) {
  const { result } = renderHook(() => useChatInputSubmit(params));
  await act(async () => {
    await result.current.handleSubmit({ preventDefault: vi.fn() } as any);
  });
}

describe('applyPendingCommandPrefix', () => {
  it('拼回 `/${id} ` 前缀，已带同名前缀时不重复加', () => {
    expect(applyPendingCommandPrefix('修好发布链路', { id: 'goal', name: '设定目标' })).toBe('/goal 修好发布链路');
    expect(applyPendingCommandPrefix('', { id: 'goal', name: '设定目标' })).toBe('/goal');
    expect(applyPendingCommandPrefix('/goal 已有前缀', { id: 'goal', name: '设定目标' })).toBe('/goal 已有前缀');
    expect(applyPendingCommandPrefix('/goalkeeper 不算', { id: 'goal', name: '设定目标' })).toBe('/goal /goalkeeper 不算');
  });
});

describe('pendingCommand chip 的提交流', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useComposerStore.setState({ pendingCommand: null, selectedTeamRecipeId: null, standbyExcludedMemberKeys: [] });
  });

  it('goal chip + 参数文本 → 与手打「/goal xxx」一致走安静确认卡，chip 清掉', async () => {
    useComposerStore.setState({ pendingCommand: { id: 'goal', name: '设定目标' } });
    const openGoalConfirm = vi.fn();
    const onSend = vi.fn();
    await submit(makeParams({ value: '修好发布链路', openGoalConfirm, onSend }));

    expect(openGoalConfirm).toHaveBeenCalledWith('修好发布链路');
    expect(onSend).not.toHaveBeenCalled();
    expect(useComposerStore.getState().pendingCommand).toBeNull();
  });

  it('workflow chip + 参数文本 → 按「/workflow <文本>」原文走普通发送链路', async () => {
    useComposerStore.setState({ pendingCommand: { id: 'workflow', name: '编排工作流' } });
    const onSend = vi.fn().mockResolvedValue(true);
    await submit(makeParams({ value: '先调研再出报告', onSend }));

    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({
      content: '/workflow 先调研再出报告',
      clientMessageId: expect.any(String),
    }));
    expect(useComposerStore.getState().pendingCommand).toBeNull();
  });

  it('schedule chip 空参数 → 与手打裸 /schedule 一致打开对话式创建卡', async () => {
    useComposerStore.setState({ pendingCommand: { id: 'schedule', name: '定时任务' } });
    const setScheduleComposerOpen = vi.fn();
    const onSend = vi.fn();
    await submit(makeParams({ value: '', setScheduleComposerOpen, onSend }));

    expect(setScheduleComposerOpen).toHaveBeenCalledWith(true);
    expect(onSend).not.toHaveBeenCalled();
    expect(useComposerStore.getState().pendingCommand).toBeNull();
  });

  it('loop chip 空参数 → 与手打裸 /loop 一致只提示用法，chip 保留让用户补参数', async () => {
    useComposerStore.setState({ pendingCommand: { id: 'loop', name: '会话循环' } });
    const onSend = vi.fn();
    await submit(makeParams({ value: '', onSend }));

    expect(mocks.toast.warning).toHaveBeenCalledWith(expect.stringContaining('/loop'));
    expect(onSend).not.toHaveBeenCalled();
    expect(useComposerStore.getState().pendingCommand).toEqual({ id: 'loop', name: '会话循环' });
  });

  it('发送失败 restoreDraft 时 chip 随草稿一起还回来', async () => {
    useComposerStore.setState({ pendingCommand: { id: 'workflow', name: '编排工作流' } });
    const onSend = vi.fn().mockResolvedValue(false);
    const setValue = vi.fn();
    await submit(makeParams({ value: '先调研再出报告', onSend, setValue }));

    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({
      content: '/workflow 先调研再出报告',
      clientMessageId: expect.any(String),
    }));
    expect(setValue).toHaveBeenCalledWith('先调研再出报告');
    expect(useComposerStore.getState().pendingCommand).toEqual({ id: 'workflow', name: '编排工作流' });
  });
});

describe('命令提交结束草稿时丢掉失败重发 pending id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoke.mockResolvedValue({ success: true });
    useComposerStore.setState({ pendingCommand: null, selectedTeamRecipeId: null, standbyExcludedMemberKeys: [] });
  });

  it.each([
    ['/compact', 'compact'],
    ['/schedule', '裸 schedule 开创建卡'],
    ['/goal 修好发布链路', 'goal 确认卡'],
    ['/create-team', '建团队 seed'],
    ['/agent default', '清专家 chip'],
  ])('%s 清空输入后 pending 丢掉', async (value) => {
    const pendingResendClientMessageIdRef = { current: 'failed-bubble-id' as string | null };
    await submit(makeParams({ value, pendingResendClientMessageIdRef, onSend: vi.fn() }));
    expect(pendingResendClientMessageIdRef.current).toBeNull();
  });

  it('/loop 缺参只提示、草稿还在，pending 保留', async () => {
    const pendingResendClientMessageIdRef = { current: 'failed-bubble-id' as string | null };
    await submit(makeParams({ value: '/loop', pendingResendClientMessageIdRef, onSend: vi.fn() }));
    expect(pendingResendClientMessageIdRef.current).toBe('failed-bubble-id');
  });

  it('编辑失败消息后提交 /compact，再发 B 是新 id，不复用 A', async () => {
    const pendingResendClientMessageIdRef = { current: 'failed-bubble-id' as string | null };
    await submit(makeParams({
      value: '/compact',
      pendingResendClientMessageIdRef,
      onSend: vi.fn(),
    }));
    expect(pendingResendClientMessageIdRef.current).toBeNull();

    const onSend = vi.fn().mockResolvedValue(true);
    await submit(makeParams({
      value: '正文 B',
      pendingResendClientMessageIdRef,
      onSend,
    }));
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ content: '正文 B' }));
    expect(onSend.mock.calls[0]?.[0]?.clientMessageId).not.toBe('failed-bubble-id');
  });
});
