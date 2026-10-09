// @vitest-environment jsdom
//
// N-RUNINPUT-TOBACKGROUND-OPTION：运行中 composer 的第三个显式动作「转后台继续聊」。
// ① 可见性（只在运行中 + 草稿非空出现）与默认键位不变（Enter 排队 / Cmd+Enter 改道）；
// ② 选定后的调用序（转后台 IPC → 新会话 → 普通发送），失败路径保留草稿。

import React, { useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEnvelope } from '../../../src/shared/contract/conversationEnvelope';
import type { SteerOrQueueOutcome } from '../../../src/shared/contract/appService';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

const toastState = vi.hoisted(() => ({ error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() }));

vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: toastState,
}));

vi.mock('../../../src/renderer/components/features/chat/MessageBubble/MessageContent', () => ({
  MessageContent: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/MessageBubble/AttachmentPreview', () => ({
  AttachmentDisplay: () => null,
}));

import { InputArea, type InputAreaRef } from '../../../src/renderer/components/features/chat/ChatInput/InputArea';
import { BackgroundHandoffButton } from '../../../src/renderer/components/features/chat/ChatInput/BackgroundHandoffButton';
import { useBackgroundHandoffSubmit } from '../../../src/renderer/components/features/chat/ChatInput/useBackgroundHandoffSubmit';
import {
  useChatInputSubmit,
  type UseChatInputSubmitParams,
} from '../../../src/renderer/components/features/chat/ChatInput/useChatInputSubmit';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useMessageActionStore } from '../../../src/renderer/stores/messageActionStore';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

function makeParams(overrides: Partial<UseChatInputSubmitParams> = {}): UseChatInputSubmitParams {
  return {
    value: '换个话题：帮我写周报',
    attachments: [],
    voiceInputContext: null,
    pendingAppshot: null,
    pendingPromptCommand: null,
    pendingAgentSelection: null,
    currentSessionId: 'session-running',
    isProcessing: true,
    disabled: true,
    isUploading: false,
    onSend: vi.fn().mockResolvedValue(true),
    onSteer: vi.fn().mockResolvedValue({ outcome: 'steered' }),
    agentEntries: [],
    buildEnvelope: (content, attachments, runtimeInputMode): ConversationEnvelope => ({
      content,
      attachments,
      context: runtimeInputMode ? { runtimeInput: { mode: runtimeInputMode } } : undefined,
    }),
    openAgentCommand: vi.fn(),
    addToInputHistory: vi.fn(),
    clearAppshot: vi.fn(),
    inputAreaRef: {
      current: { focus: vi.fn(), getEditor: () => null, getCaretOffset: () => 0, replaceRangeWithChip: vi.fn(), replaceRangeWithText: vi.fn() },
    },
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

/** IPC 边界 mock：codeAgentAPI（通道 invoke）+ codeAgentDomainAPI（域 invoke）。 */
const channelInvoke = vi.fn();
const domainInvoke = vi.fn();
/** 三步调用序的时序记录。 */
const calls: string[] = [];

beforeEach(() => {
  calls.length = 0;
  toastState.error.mockClear();
  toastState.warning.mockClear();
  channelInvoke.mockImplementation(async (channel: string, sessionId: string) => {
    if (channel === IPC_CHANNELS.BACKGROUND_MOVE_TO_BACKGROUND) {
      calls.push(`move:${sessionId}`);
      return true;
    }
    return undefined;
  });
  domainInvoke.mockImplementation(async (domain: string, action: string) => {
    if (domain === 'domain:session' && action === 'create') {
      calls.push('create-session');
      return {
        success: true,
        data: { id: 'session-new', title: '新对话', createdAt: 1, updatedAt: 1 },
      };
    }
    return { success: true, data: {} };
  });
  // codeAgentAPI 是多成员 bridge 接口，这里只需 invoke —— 测试用部分 mock，显式双重转换
  window.codeAgentAPI = { invoke: channelInvoke } as unknown as typeof window.codeAgentAPI;
  window.codeAgentDomainAPI = { invoke: domainInvoke } as typeof window.codeAgentDomainAPI;
  // sessionCreate.invokeSession 读的是 legacy 别名 window.domainAPI（initTransport 同款别名关系）
  window.domainAPI = window.codeAgentDomainAPI;
  useSessionStore.setState({
    sessions: [],
    currentSessionId: 'session-running',
    messages: [],
    todos: [],
    sessionTasks: [],
    backgroundSessions: [],
  } as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.codeAgentAPI = undefined;
  window.codeAgentDomainAPI = undefined;
  window.domainAPI = undefined;
  useMessageActionStore.getState().unregister();
});

describe('① 运行中第三个显式选项的可见性', () => {
  const visibleCases: Array<[string, React.ComponentProps<typeof BackgroundHandoffButton>, boolean]> = [
    ['运行中 + 有草稿', { isProcessing: true, draftText: '草稿', attachmentCount: 0, sessionId: 's1', editingQueuedInput: false }, true],
    ['运行中 + 仅附件', { isProcessing: true, draftText: '', attachmentCount: 1, sessionId: 's1', editingQueuedInput: false }, true],
    ['空闲时不出现', { isProcessing: false, draftText: '草稿', attachmentCount: 0, sessionId: 's1', editingQueuedInput: false }, false],
    ['草稿为空时不出现', { isProcessing: true, draftText: '', attachmentCount: 0, sessionId: 's1', editingQueuedInput: false }, false],
    ['无会话（sessionless）不出现', { isProcessing: true, draftText: '草稿', attachmentCount: 0, sessionId: null, editingQueuedInput: false }, false],
    ['队列编辑态不出现', { isProcessing: true, draftText: '草稿', attachmentCount: 0, sessionId: 's1', editingQueuedInput: true }, false],
  ];

  it.each(visibleCases)('%s', (_label, props, expected) => {
    const { unmount } = render(
      <BackgroundHandoffButton {...props} onTrigger={() => {}} />,
    );
    if (expected) {
      expect(screen.getByTestId('background-handoff-button')).toBeTruthy();
    } else {
      expect(screen.queryByTestId('background-handoff-button')).toBeNull();
    }
    unmount();
  });

  it('可见时带 testid 与可访问名，隐藏时不渲染', () => {
    const base = { draftText: '草稿', attachmentCount: 0, sessionId: 's1', editingQueuedInput: false, onTrigger: vi.fn() };
    const { rerender } = render(<BackgroundHandoffButton {...base} isProcessing />);

    const button = screen.getByTestId('background-handoff-button');
    expect(button.getAttribute('aria-label')).toBe('把当前任务转入后台，在新对话里继续');
    expect(screen.getByText('转后台继续聊')).toBeTruthy();

    rerender(<BackgroundHandoffButton {...base} isProcessing={false} />);
    expect(screen.queryByTestId('background-handoff-button')).toBeNull();
  });
});

function RunningComposerHarness({
  onSend,
  onSteer,
  onSubmitOptions,
}: {
  onSend: (envelope: ConversationEnvelope) => boolean | Promise<boolean>;
  onSteer: (envelope: ConversationEnvelope) => Promise<SteerOrQueueOutcome | undefined>;
  onSubmitOptions: (opts?: { steer?: boolean; content?: string; toBackground?: boolean }) => void;
}) {
  const [value, setValue] = useState('换个话题：帮我写周报');
  const inputAreaRef = useRef<InputAreaRef>(null);
  const { handleSubmit } = useChatInputSubmit(makeParams({
    value,
    setValue,
    isProcessing: true,
    disabled: true,
    onSend,
    onSteer,
    inputAreaRef,
  }));

  return (
    <div>
      <InputArea
        ref={inputAreaRef}
        value={value}
        onChange={setValue}
        onSubmit={(opts) => { void handleSubmit(undefined, opts); }}
        onFileSelect={vi.fn()}
        isFocused={false}
        onFocusChange={vi.fn()}
      />
      <BackgroundHandoffButton
        isProcessing
        draftText={value}
        attachmentCount={0}
        sessionId="session-running"
        editingQueuedInput={false}
        onTrigger={() => onSubmitOptions({ toBackground: true })}
      />
    </div>
  );
}

describe('① 选项在场时默认键位行为不变', () => {
  it('第三个选项可见时，普通 Enter 仍走排队、Cmd+Enter 仍走改道', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const onSteer = vi.fn().mockResolvedValue({ outcome: 'steered' });
    render(
      <RunningComposerHarness
        onSend={onSend}
        onSteer={onSteer}
        onSubmitOptions={() => {}}
      />,
    );

    // 选项在场（运行中 + 草稿非空）
    expect(screen.getByTestId('background-handoff-button')).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(domainInvoke).toHaveBeenCalledWith(
      'domain:queuedInput',
      'enqueue',
      expect.objectContaining({ sessionId: 'session-running' }),
    ));
    expect(onSend).not.toHaveBeenCalled();

    domainInvoke.mockClear();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(onSteer).toHaveBeenCalledTimes(1));
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('② 选定后的调用序与失败处理', () => {
  function renderHandoff() {
    const onSend = vi.fn().mockResolvedValue(true);
    const submitParams = makeParams({ onSend });
    const { result } = renderHook(() => {
      const submit = useChatInputSubmit(submitParams);
      const handoff = useBackgroundHandoffSubmit({
        currentSessionId: 'session-running',
        handleSubmit: submit.handleSubmit,
      });
      return { handoff };
    });
    return { result, onSend, submitParams };
  }

  it('按 转后台 → 新会话 → 普通发送 的顺序执行，且不排队、不带运行中输入模式', async () => {
    const { result, onSend } = renderHandoff();

    await act(async () => {
      await result.current.handoff();
    });

    // 调用序：转后台 IPC → 会话创建 → 发送
    expect(calls).toEqual(['move:session-running', 'create-session']);
    expect(channelInvoke).toHaveBeenCalledWith(IPC_CHANNELS.BACKGROUND_MOVE_TO_BACKGROUND, 'session-running');
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toMatchObject({
      content: '换个话题：帮我写周报',
      context: undefined,
    });
    // 不进排队分支（无 queuedInput enqueue）
    expect(domainInvoke.mock.calls.some(([action]) => action === 'enqueue')).toBe(false);
    // 发送后 store 已切到新会话
    expect(useSessionStore.getState().currentSessionId).toBe('session-new');
  });

  it('转后台失败：报错提示、不建新会话、不发送、草稿保留', async () => {
    channelInvoke.mockImplementation(async (channel: string) => {
      if (channel === IPC_CHANNELS.BACKGROUND_MOVE_TO_BACKGROUND) return false;
      return undefined;
    });
    const { result, onSend, submitParams } = renderHandoff();

    await act(async () => {
      await result.current.handoff();
    });

    expect(toastState.error).toHaveBeenCalledWith('没能把当前任务转到后台，这句话还留在输入框');
    expect(calls).toEqual([]);
    expect(onSend).not.toHaveBeenCalled();
    // 草稿还在：composer 清空调用一次都没发生
    expect(submitParams.setValue).not.toHaveBeenCalled();
  });

  it('新会话创建失败：报错提示、不发送、草稿保留', async () => {
    domainInvoke.mockImplementation(async (domain: string, action: string) => {
      if (domain === 'domain:session' && action === 'create') {
        calls.push('create-session');
        return { success: false, error: { code: 'CREATE_FAILED', message: 'nope' } };
      }
      return { success: true, data: {} };
    });
    const { result, onSend, submitParams } = renderHandoff();

    await act(async () => {
      await result.current.handoff();
    });

    expect(calls).toEqual(['move:session-running', 'create-session']);
    expect(toastState.error).toHaveBeenCalledWith('任务已转后台，但没能打开新对话，这句话还留在输入框');
    expect(onSend).not.toHaveBeenCalled();
    expect(submitParams.setValue).not.toHaveBeenCalled();
  });
});
