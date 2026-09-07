// @vitest-environment jsdom

import React, { useRef, useState } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SteerOrQueueOutcome } from '../../../src/shared/contract/appService';
import type { ConversationEnvelope } from '../../../src/shared/contract/conversationEnvelope';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

import { InputArea, type InputAreaRef } from '../../../src/renderer/components/features/chat/ChatInput/InputArea';
import {
  useChatInputSubmit,
  type UseChatInputSubmitParams,
} from '../../../src/renderer/components/features/chat/ChatInput/useChatInputSubmit';
import { submitSteerEnvelope } from '../../../src/renderer/components/features/chat/chatViewSteer';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useMessageActionStore } from '../../../src/renderer/stores/messageActionStore';
import { markOptimisticUserSendFailed } from '../../../src/renderer/utils/optimisticUserSend';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

function makeParams(overrides: Partial<UseChatInputSubmitParams> = {}): UseChatInputSubmitParams {
  return {
    value: '请改成更简洁的方案',
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

const domainInvoke = vi.fn();

beforeEach(() => {
  domainInvoke.mockResolvedValue({
    success: true,
    data: {
      id: 'queued-input-1',
      sessionId: 'session-running',
      envelope: { content: '请改成更简洁的方案' },
      status: 'queued',
      retryCount: 0,
      createdAt: 1,
      updatedAt: 1,
    },
  });
  window.codeAgentDomainAPI = { invoke: domainInvoke } as typeof window.codeAgentDomainAPI;
});

function SubmitHarness({
  isProcessing,
  onSend,
  onSteer,
  initialValue = '请改成更简洁的方案',
  pendingResendClientMessageIdRef,
}: {
  isProcessing: boolean;
  onSend: (envelope: ConversationEnvelope) => boolean | Promise<boolean>;
  onSteer: (envelope: ConversationEnvelope) => Promise<SteerOrQueueOutcome | undefined>;
  initialValue?: string;
  pendingResendClientMessageIdRef?: { current: string | null };
}) {
  const [value, setValue] = useState(initialValue);
  const inputAreaRef = useRef<InputAreaRef>(null);
  const { handleSubmit } = useChatInputSubmit(makeParams({
    value,
    setValue,
    isProcessing,
    disabled: isProcessing,
    onSend,
    onSteer,
    inputAreaRef,
    pendingResendClientMessageIdRef,
  }));

  return (
    <InputArea
      ref={inputAreaRef}
      value={value}
      onChange={setValue}
      onSubmit={(opts) => { void handleSubmit(undefined, opts); }}
      onFileSelect={vi.fn()}
      isFocused={false}
      onFocusChange={vi.fn()}
      placeholder={isProcessing ? '继续描述…（Enter 排队，⌘/Ctrl+Enter 改道）' : undefined}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.codeAgentDomainAPI = undefined;
  useMessageActionStore.getState().unregister();
});

describe('mid-turn composer submission', () => {
  it.each([
    ['Cmd+Enter', { metaKey: true }],
    ['Ctrl+Enter', { ctrlKey: true }],
  ])('routes %s to the running-turn adjustment path', async (_label, modifiers) => {
    const onSend = vi.fn().mockResolvedValue(true);
    const onSteer = vi.fn().mockResolvedValue({ outcome: 'steered' });
    render(<SubmitHarness isProcessing onSend={onSend} onSteer={onSteer} />);

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ...modifiers });

    await waitFor(() => expect(onSteer).toHaveBeenCalledTimes(1));
    expect(onSteer).toHaveBeenCalledWith(expect.objectContaining({
      content: '请改成更简洁的方案',
      context: { runtimeInput: { mode: 'redirect' } },
    }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('puts ordinary Enter into the durable list while running', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const onSteer = vi.fn().mockResolvedValue({ outcome: 'steered' });
    render(<SubmitHarness isProcessing onSend={onSend} onSteer={onSteer} />);

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    await waitFor(() => expect(domainInvoke).toHaveBeenCalledTimes(1));
    expect(domainInvoke).toHaveBeenCalledWith(
      'domain:queuedInput',
      'enqueue',
      expect.objectContaining({
        sessionId: 'session-running',
        envelope: expect.objectContaining({
          content: '请改成更简洁的方案',
          context: { runtimeInput: { mode: 'supplement' } },
        }),
      }),
    );
    expect(onSend).not.toHaveBeenCalled();
    expect(onSteer).not.toHaveBeenCalled();
  });

  it('运行期间编辑重发走排队路径时复用原 clientMessageId', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const onSteer = vi.fn().mockResolvedValue({ outcome: 'steered' });
    const pendingResendClientMessageIdRef = { current: 'failed-bubble-id' as string | null };
    render(
      <SubmitHarness
        isProcessing
        onSend={onSend}
        onSteer={onSteer}
        pendingResendClientMessageIdRef={pendingResendClientMessageIdRef}
      />,
    );

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    await waitFor(() => expect(domainInvoke).toHaveBeenCalledTimes(1));
    expect(domainInvoke).toHaveBeenCalledWith(
      'domain:queuedInput',
      'enqueue',
      expect.objectContaining({
        id: 'failed-bubble-id',
        sessionId: 'session-running',
        envelope: expect.objectContaining({
          clientMessageId: 'failed-bubble-id',
          content: '请改成更简洁的方案',
        }),
      }),
    );
    expect(pendingResendClientMessageIdRef.current).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not render the running queue/redirect segmented choice and exposes the shortcut hint', () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const onSteer = vi.fn().mockResolvedValue({ outcome: 'steered' });
    render(<SubmitHarness isProcessing onSend={onSend} onSteer={onSteer} initialValue="" />);

    expect(screen.queryByTestId('runtime-input-choice')).toBeNull();
    expect(screen.getByText('继续描述…（Enter 排队，⌘/Ctrl+Enter 改道）')).toBeTruthy();

    const source = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/features/chat/ChatInput/index.tsx'),
      'utf8',
    );
    expect(source).not.toContain('RuntimeInputChoice');
  });

  it.each([
    ['Cmd+Enter', { metaKey: true }],
    ['Ctrl+Enter', { ctrlKey: true }],
  ])('treats %s as ordinary send while idle', async (_label, modifiers) => {
    const onSend = vi.fn().mockResolvedValue(true);
    const onSteer = vi.fn().mockResolvedValue({ outcome: 'steered' });
    render(<SubmitHarness isProcessing={false} onSend={onSend} onSteer={onSteer} />);

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ...modifiers });

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSteer).not.toHaveBeenCalled();
  });

  it('restores and focuses the draft when the adjustment request fails', async () => {
    const setValue = vi.fn();
    const focus = vi.fn();
    const params = makeParams({
      setValue,
      inputAreaRef: {
        current: { focus, getEditor: () => null, getCaretOffset: () => 0, replaceRangeWithChip: vi.fn(), replaceRangeWithText: vi.fn() },
      },
      onSteer: vi.fn().mockResolvedValue(undefined),
    });
    const { result } = renderHook(() => useChatInputSubmit(params));

    await act(async () => {
      await result.current.handleSubmit(undefined, { steer: true });
    });

    expect(setValue).toHaveBeenLastCalledWith('请改成更简洁的方案');
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('空闲发送把草稿 pending id 写进 envelope；回滚时 pending 随草稿回来', async () => {
    const pendingResendClientMessageIdRef = { current: 'failed-bubble-id' as string | null };
    const onSend = vi.fn().mockResolvedValue(false);
    const params = makeParams({
      isProcessing: false,
      disabled: false,
      onSend,
      pendingResendClientMessageIdRef,
    });
    const { result } = renderHook(() => useChatInputSubmit(params));

    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({
      clientMessageId: 'failed-bubble-id',
      content: '请改成更简洁的方案',
    }));
    expect(pendingResendClientMessageIdRef.current).toBe('failed-bubble-id');
  });

  it('排队成功后下一次普通发送不再误用残留 pending id', async () => {
    const pendingResendClientMessageIdRef = { current: 'failed-bubble-id' as string | null };
    const params = makeParams({
      pendingResendClientMessageIdRef,
    });
    const { result } = renderHook(() => useChatInputSubmit(params));

    await act(async () => {
      await result.current.handleSubmit();
    });
    expect(domainInvoke.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ id: 'failed-bubble-id' }));
    expect(pendingResendClientMessageIdRef.current).toBeNull();

    await act(async () => {
      await result.current.handleSubmit();
    });
    const secondId = (domainInvoke.mock.calls[1]?.[2] as { id?: string } | undefined)?.id;
    expect(secondId).toBeTruthy();
    expect(secondId).not.toBe('failed-bubble-id');
  });

  it('空闲发送成功后 pending id 不残留', async () => {
    const pendingResendClientMessageIdRef = { current: 'failed-bubble-id' as string | null };
    const onSend = vi.fn().mockResolvedValue(true);
    const params = makeParams({
      isProcessing: false,
      disabled: false,
      onSend,
      pendingResendClientMessageIdRef,
    });
    const { result } = renderHook(() => useChatInputSubmit(params));

    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({
      clientMessageId: 'failed-bubble-id',
    }));
    expect(pendingResendClientMessageIdRef.current).toBeNull();
  });

  it('运行中编辑重发入队后，同 id 失败气泡换成新正文且无失败态，再点编辑重发取回新正文', async () => {
    useSessionStore.setState({
      currentSessionId: 'session-running',
      messages: [{
        id: 'failed-bubble-id',
        role: 'user',
        content: '原文 A',
        timestamp: 1,
        metadata: { sendFailed: true },
      }],
    } as never);
    const restoreComposer = vi.fn();
    useMessageActionStore.getState().register(
      vi.fn(),
      () => useSessionStore.getState().messages,
      restoreComposer,
    );
    const pendingResendClientMessageIdRef = { current: 'failed-bubble-id' as string | null };
    const params = makeParams({
      value: '改过的需求 B',
      pendingResendClientMessageIdRef,
    });
    const { result } = renderHook(() => useChatInputSubmit(params));

    await act(async () => {
      await result.current.handleSubmit();
    });

    const user = useSessionStore.getState().messages.find((message) => message.id === 'failed-bubble-id');
    expect(user?.content).toBe('改过的需求 B');
    expect(user?.metadata?.sendFailed).toBeUndefined();

    // 入队成功后失败态已清，编辑重发入口随之消失。同 id 若再次失败，入口读的是更新后的 B，不是化石 A。
    markOptimisticUserSendFailed('failed-bubble-id');
    useMessageActionStore.getState().editAndResendMessage('failed-bubble-id');
    expect(restoreComposer).toHaveBeenCalledWith(expect.objectContaining({
      content: '改过的需求 B',
      clientMessageId: 'failed-bubble-id',
    }));
  });

  it('插话成功时把同 id 失败气泡替换成新正文并清失败态', async () => {
    useSessionStore.setState({
      currentSessionId: 'session-running',
      messages: [{
        id: 'failed-bubble-id',
        role: 'user',
        content: '原文 A',
        timestamp: 1,
        metadata: { sendFailed: true },
      }],
    } as never);
    domainInvoke.mockResolvedValueOnce({
      success: true,
      data: { outcome: 'steered' },
    });

    const outcome = await submitSteerEnvelope({
      content: '改过的需求 B',
      clientMessageId: 'failed-bubble-id',
      attachments: [],
      context: { runtimeInput: { mode: 'redirect' } },
    }, 'session-running', 'turn-visible');

    expect(outcome?.outcome).toBe('steered');
    expect(domainInvoke).toHaveBeenCalledWith(
      IPC_DOMAINS.AGENT,
      'interrupt',
      expect.objectContaining({ clientMessageId: 'failed-bubble-id', content: '改过的需求 B' }),
    );
    const user = useSessionStore.getState().messages.find((message) => message.id === 'failed-bubble-id');
    expect(user?.content).toBe('改过的需求 B');
    expect(user?.metadata?.sendFailed).toBeUndefined();
    expect(useSessionStore.getState().messages.filter((message) => message.role === 'user')).toHaveLength(1);
  });

  it('插话被排进队列时也不撤掉已替换的失败气泡', async () => {
    useSessionStore.setState({
      currentSessionId: 'session-running',
      messages: [{
        id: 'failed-bubble-id',
        role: 'user',
        content: '原文 A',
        timestamp: 1,
        metadata: { sendFailed: true },
      }],
    } as never);
    domainInvoke.mockResolvedValueOnce({
      success: true,
      data: { outcome: 'queued', queuedInputId: 'buffered-1', code: 'TURN_CHANGED', message: 'queued' },
    });

    const outcome = await submitSteerEnvelope({
      content: '改过的需求 B',
      clientMessageId: 'failed-bubble-id',
    }, 'session-running', 'turn-visible');

    expect(outcome?.outcome).toBe('queued');
    const user = useSessionStore.getState().messages.find((message) => message.id === 'failed-bubble-id');
    expect(user?.content).toBe('改过的需求 B');
    expect(user?.metadata?.sendFailed).toBeUndefined();
  });
});
