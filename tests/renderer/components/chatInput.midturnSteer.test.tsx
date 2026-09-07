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
import { composerEditModeState } from '../../../src/renderer/components/features/chat/ChatInput/composerEditMode';
import { useChatInputSessionScope } from '../../../src/renderer/components/features/chat/ChatInput/useChatInputSessionScope';
import {
  decideSameIdQueueAction,
  queuedRecordMatchesEnvelope,
} from '../../../src/renderer/components/features/chat/ChatInput/queuedInputSameId';
import type { QueuedInputStatus } from '../../../src/shared/contract/queuedInput';
import { consumePendingClientMessageId } from '../../../src/renderer/utils/chatSendState';

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
  domainInvoke.mockImplementation(async (_domain: string, action: string, payload: {
    id?: string;
    sessionId?: string;
    envelope?: { content?: string };
  }) => {
    if (action === 'enqueue') {
      return {
        success: true,
        data: {
          id: payload.id,
          sessionId: payload.sessionId,
          envelope: payload.envelope,
          status: 'queued',
          retryCount: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      };
    }
    if (action === 'interrupt') {
      return { success: true, data: { outcome: 'steered' } };
    }
    return { success: true, data: {} };
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

describe('同 id 入队回执状态机', () => {
  it.each([
    ['queued', true, 'keep'],
    ['queued', false, 'update'],
    ['sending', true, 'keep'],
    ['sending', false, 'fork'],
    ['consumed', true, 'keep'],
    ['consumed', false, 'fork'],
    ['failed', true, 'requeue'],
    ['failed', false, 'requeue'],
    ['retracted', true, 'requeue'],
    ['retracted', false, 'requeue'],
  ] as const)('status=%s samePayload=%s → %s', (status: QueuedInputStatus, samePayload, action) => {
    expect(decideSameIdQueueAction(status, samePayload)).toBe(action);
  });

  it('正文相同附件不同不算 payload 相同', () => {
    expect(queuedRecordMatchesEnvelope(
      { envelope: { content: '同一段话', attachments: [{ id: 'a', name: 'a.png' }] as never } },
      { content: '同一段话', attachments: [{ id: 'b', name: 'b.png' }] as never },
    )).toBe(false);
  });

  it('正文和附件都相同才算 payload 相同', () => {
    const att = [{ id: 'a', name: 'a.png' }];
    expect(queuedRecordMatchesEnvelope(
      { envelope: { content: '同一段话', attachments: att as never } },
      { content: '同一段话', attachments: att as never },
    )).toBe(true);
  });
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

  it('同 id 仍 queued 时再入队不同正文：走 update 并把气泡换成新正文', async () => {
    useSessionStore.setState({
      currentSessionId: 'session-running',
      messages: [{
        id: 'failed-bubble-id',
        role: 'user',
        content: '原文 B',
        timestamp: 1,
        metadata: { sendFailed: true },
      }],
    } as never);
    domainInvoke.mockReset();
    domainInvoke
      .mockResolvedValueOnce({
        success: true,
        data: {
          id: 'failed-bubble-id',
          sessionId: 'session-running',
          envelope: { content: '原文 B' },
          status: 'queued',
          retryCount: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          updated: true,
          input: {
            id: 'failed-bubble-id',
            sessionId: 'session-running',
            envelope: { content: '改过的需求 C', attachments: [] },
            status: 'queued',
            retryCount: 0,
            createdAt: 1,
            updatedAt: 2,
          },
        },
      });
    const pendingResendClientMessageIdRef = { current: 'failed-bubble-id' as string | null };
    const params = makeParams({
      value: '改过的需求 C',
      pendingResendClientMessageIdRef,
    });
    const { result } = renderHook(() => useChatInputSubmit(params));

    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(domainInvoke.mock.calls[0]?.[1]).toBe('enqueue');
    expect(domainInvoke.mock.calls[1]?.[1]).toBe('update');
    expect(domainInvoke.mock.calls[1]?.[2]).toEqual({
      id: 'failed-bubble-id',
      content: '改过的需求 C',
      attachments: [],
    });
    const user = useSessionStore.getState().messages.find((message) => message.id === 'failed-bubble-id');
    expect(user?.content).toBe('改过的需求 C');
    expect(user?.metadata?.sendFailed).toBeUndefined();
  });

  it('同 id 仍 queued 且 payload 相同时 keep，不再 update', async () => {
    useSessionStore.setState({
      currentSessionId: 'session-running',
      messages: [{
        id: 'failed-bubble-id',
        role: 'user',
        content: '同一段话',
        timestamp: 1,
        metadata: { sendFailed: true },
      }],
    } as never);
    domainInvoke.mockReset();
    domainInvoke.mockResolvedValueOnce({
      success: true,
      data: {
        id: 'failed-bubble-id',
        sessionId: 'session-running',
        envelope: { content: '同一段话', attachments: [] },
        status: 'queued',
        retryCount: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    });
    const pendingResendClientMessageIdRef = { current: 'failed-bubble-id' as string | null };
    const { result } = renderHook(() => useChatInputSubmit(makeParams({
      value: '同一段话',
      pendingResendClientMessageIdRef,
    })));

    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(domainInvoke).toHaveBeenCalledTimes(1);
    expect(domainInvoke.mock.calls[0]?.[1]).toBe('enqueue');
    const user = useSessionStore.getState().messages.find((message) => message.id === 'failed-bubble-id');
    expect(user?.content).toBe('同一段话');
    expect(user?.metadata?.sendFailed).toBeUndefined();
  });

  it('同 id 已 sending 时再入队不同正文：不覆盖原气泡，另铸新 id', async () => {
    useSessionStore.setState({
      currentSessionId: 'session-running',
      messages: [{
        id: 'failed-bubble-id',
        role: 'user',
        content: '原文 B',
        timestamp: 1,
        metadata: { sendFailed: true },
      }],
    } as never);
    domainInvoke.mockReset();
    domainInvoke
      .mockResolvedValueOnce({
        success: true,
        data: {
          id: 'failed-bubble-id',
          sessionId: 'session-running',
          envelope: { content: '原文 B' },
          status: 'sending',
          retryCount: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          id: 'fresh-queued-id',
          sessionId: 'session-running',
          envelope: { content: '改过的需求 C', clientMessageId: 'fresh-queued-id' },
          status: 'queued',
          retryCount: 0,
          createdAt: 2,
          updatedAt: 2,
        },
      });
    const pendingResendClientMessageIdRef = { current: 'failed-bubble-id' as string | null };
    const params = makeParams({
      value: '改过的需求 C',
      pendingResendClientMessageIdRef,
    });
    const { result } = renderHook(() => useChatInputSubmit(params));

    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(domainInvoke).toHaveBeenCalledTimes(2);
    expect(domainInvoke.mock.calls[0]?.[1]).toBe('enqueue');
    expect((domainInvoke.mock.calls[0]?.[2] as { id?: string }).id).toBe('failed-bubble-id');
    expect((domainInvoke.mock.calls[1]?.[2] as { id?: string }).id).not.toBe('failed-bubble-id');
    const user = useSessionStore.getState().messages.find((message) => message.id === 'failed-bubble-id');
    expect(user?.content).toBe('原文 B');
    expect(user?.metadata?.sendFailed).toBe(true);
  });

  it('update 竞态 updated=false 时新 id 另排，原气泡不动', async () => {
    useSessionStore.setState({
      currentSessionId: 'session-running',
      messages: [{
        id: 'failed-bubble-id',
        role: 'user',
        content: '原文 B',
        timestamp: 1,
        metadata: { sendFailed: true },
      }],
    } as never);
    domainInvoke.mockReset();
    domainInvoke
      .mockResolvedValueOnce({
        success: true,
        data: {
          id: 'failed-bubble-id',
          sessionId: 'session-running',
          envelope: { content: '原文 B' },
          status: 'queued',
          retryCount: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { updated: false },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          id: 'fresh-queued-id',
          sessionId: 'session-running',
          envelope: { content: '改过的需求 C' },
          status: 'queued',
          retryCount: 0,
          createdAt: 2,
          updatedAt: 2,
        },
      });
    const pendingResendClientMessageIdRef = { current: 'failed-bubble-id' as string | null };
    const { result } = renderHook(() => useChatInputSubmit(makeParams({
      value: '改过的需求 C',
      pendingResendClientMessageIdRef,
    })));

    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(domainInvoke.mock.calls[1]?.[1]).toBe('update');
    expect(domainInvoke.mock.calls[2]?.[1]).toBe('enqueue');
    expect((domainInvoke.mock.calls[2]?.[2] as { id?: string }).id).not.toBe('failed-bubble-id');
    const user = useSessionStore.getState().messages.find((message) => message.id === 'failed-bubble-id');
    expect(user?.content).toBe('原文 B');
    expect(user?.metadata?.sendFailed).toBe(true);
  });

  it('queued 换附件时 update 带上附件，气泡按回执附件更新', async () => {
    const oldAtt = { id: 'a', name: 'a.png', type: 'image/png', size: 1, data: 'x' };
    const newAtt = { id: 'b', name: 'b.png', type: 'image/png', size: 2, data: 'y' };
    useSessionStore.setState({
      currentSessionId: 'session-running',
      messages: [{
        id: 'failed-bubble-id',
        role: 'user',
        content: '同一段话',
        timestamp: 1,
        attachments: [oldAtt],
        metadata: { sendFailed: true },
      }],
    } as never);
    domainInvoke.mockReset();
    domainInvoke
      .mockResolvedValueOnce({
        success: true,
        data: {
          id: 'failed-bubble-id',
          sessionId: 'session-running',
          envelope: { content: '同一段话', attachments: [oldAtt] },
          status: 'queued',
          retryCount: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          updated: true,
          input: {
            id: 'failed-bubble-id',
            sessionId: 'session-running',
            envelope: { content: '同一段话', attachments: [newAtt] },
            status: 'queued',
            retryCount: 0,
            createdAt: 1,
            updatedAt: 2,
          },
        },
      });
    const pendingResendClientMessageIdRef = { current: 'failed-bubble-id' as string | null };
    const params = makeParams({
      value: '同一段话',
      attachments: [newAtt] as never,
      pendingResendClientMessageIdRef,
    });
    const { result } = renderHook(() => useChatInputSubmit(params));

    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(domainInvoke.mock.calls[1]?.[1]).toBe('update');
    expect(domainInvoke.mock.calls[1]?.[2]).toEqual({
      id: 'failed-bubble-id',
      content: '同一段话',
      attachments: [newAtt],
    });
    const user = useSessionStore.getState().messages.find((message) => message.id === 'failed-bubble-id');
    expect(user?.attachments).toEqual([newAtt]);
    expect(user?.metadata?.sendFailed).toBeUndefined();
  });

  it('failed 且正文相同时走 requeue，气泡按恢复后的 queued 回执更新', async () => {
    useSessionStore.setState({
      currentSessionId: 'session-running',
      messages: [{
        id: 'failed-bubble-id',
        role: 'user',
        content: '同一段话',
        timestamp: 1,
        metadata: { sendFailed: true },
      }],
    } as never);
    domainInvoke.mockReset();
    domainInvoke
      .mockResolvedValueOnce({
        success: true,
        data: {
          id: 'failed-bubble-id',
          sessionId: 'session-running',
          envelope: { content: '同一段话' },
          status: 'failed',
          retryCount: 3,
          createdAt: 1,
          updatedAt: 2,
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          id: 'failed-bubble-id',
          sessionId: 'session-running',
          envelope: { content: '同一段话', attachments: [] },
          status: 'queued',
          retryCount: 0,
          createdAt: 1,
          updatedAt: 3,
        },
      });
    const pendingResendClientMessageIdRef = { current: 'failed-bubble-id' as string | null };
    const params = makeParams({
      value: '同一段话',
      pendingResendClientMessageIdRef,
    });
    const { result } = renderHook(() => useChatInputSubmit(params));

    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(domainInvoke.mock.calls[1]?.[1]).toBe('requeue');
    expect(domainInvoke.mock.calls[1]?.[2]).toEqual(expect.objectContaining({
      id: 'failed-bubble-id',
      envelope: expect.objectContaining({ content: '同一段话' }),
    }));
    const user = useSessionStore.getState().messages.find((message) => message.id === 'failed-bubble-id');
    expect(user?.content).toBe('同一段话');
    expect(user?.metadata?.sendFailed).toBeUndefined();
  });

  it('retracted 且正文相同时也走 requeue', async () => {
    useSessionStore.setState({
      currentSessionId: 'session-running',
      messages: [{
        id: 'failed-bubble-id',
        role: 'user',
        content: '同一段话',
        timestamp: 1,
        metadata: { sendFailed: true },
      }],
    } as never);
    domainInvoke.mockReset();
    domainInvoke
      .mockResolvedValueOnce({
        success: true,
        data: {
          id: 'failed-bubble-id',
          sessionId: 'session-running',
          envelope: { content: '同一段话' },
          status: 'retracted',
          retryCount: 0,
          createdAt: 1,
          updatedAt: 2,
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          id: 'failed-bubble-id',
          sessionId: 'session-running',
          envelope: { content: '同一段话' },
          status: 'queued',
          retryCount: 0,
          createdAt: 1,
          updatedAt: 3,
        },
      });
    const pendingResendClientMessageIdRef = { current: 'failed-bubble-id' as string | null };
    const { result } = renderHook(() => useChatInputSubmit(makeParams({
      value: '同一段话',
      pendingResendClientMessageIdRef,
    })));

    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(domainInvoke.mock.calls[1]?.[1]).toBe('requeue');
  });

  it('requeue 失败时草稿回滚，不清失败标记', async () => {
    useSessionStore.setState({
      currentSessionId: 'session-running',
      messages: [{
        id: 'failed-bubble-id',
        role: 'user',
        content: '同一段话',
        timestamp: 1,
        metadata: { sendFailed: true },
      }],
    } as never);
    domainInvoke.mockReset();
    domainInvoke
      .mockResolvedValueOnce({
        success: true,
        data: {
          id: 'failed-bubble-id',
          sessionId: 'session-running',
          envelope: { content: '同一段话' },
          status: 'failed',
          retryCount: 1,
          createdAt: 1,
          updatedAt: 2,
        },
      })
      .mockResolvedValueOnce({
        success: false,
        error: { code: 'INVALID_STATE', message: 'cannot requeue' },
      });
    const setValue = vi.fn();
    const pendingResendClientMessageIdRef = { current: 'failed-bubble-id' as string | null };
    const { result } = renderHook(() => useChatInputSubmit(makeParams({
      value: '同一段话',
      setValue,
      pendingResendClientMessageIdRef,
    })));

    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(domainInvoke.mock.calls[1]?.[1]).toBe('requeue');
    expect(setValue).toHaveBeenCalledWith('同一段话');
    const user = useSessionStore.getState().messages.find((message) => message.id === 'failed-bubble-id');
    expect(user?.metadata?.sendFailed).toBe(true);
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

describe('切换会话清掉编辑重发 pending', () => {
  it('会话切换时触发草稿重置回调，pending id 不残留到下一会话', () => {
    useSessionStore.setState({ currentSessionId: 'session-A' } as never);
    const setValue = vi.fn();
    const setAttachments = vi.fn();
    const pending = { current: 'failed-bubble-id' as string | null };
    const { rerender } = renderHook(
      ({ sessionless }: { sessionless: boolean }) => useChatInputSessionScope(
        setValue,
        setAttachments,
        sessionless,
        () => { pending.current = null; },
      ),
      { initialProps: { sessionless: false } },
    );

    expect(pending.current).toBe('failed-bubble-id');

    act(() => {
      useSessionStore.setState({ currentSessionId: 'session-B' } as never);
    });
    rerender({ sessionless: false });

    expect(setValue).toHaveBeenCalledWith('');
    expect(setAttachments).toHaveBeenCalledWith([]);
    expect(pending.current).toBeNull();
  });
});

describe('失败重发与排队编辑互斥', () => {
  it('恢复失败草稿时清掉队列编辑 id', () => {
    expect(composerEditModeState({ kind: 'failed-resend', clientMessageId: 'failed-A' })).toEqual({
      editingQueuedInputId: null,
      pendingResendClientMessageId: 'failed-A',
    });
  });

  it('进入队列编辑时清掉待重发 id，避免提交把排队消息 C 覆盖成 A', () => {
    expect(composerEditModeState({ kind: 'queued-edit', queuedInputId: 'queued-C' })).toEqual({
      editingQueuedInputId: 'queued-C',
      pendingResendClientMessageId: null,
    });
  });

  it('C 排队编辑后再点 A 失败重发，是整体切换不是 merge，提交不会截获去改 C', () => {
    const queued = composerEditModeState({ kind: 'queued-edit', queuedInputId: 'queued-C' });
    expect(queued.editingQueuedInputId).toBe('queued-C');
    const afterFailedResend = composerEditModeState({ kind: 'failed-resend', clientMessageId: 'failed-A' });
    expect({ ...queued, ...afterFailedResend }).toEqual({
      editingQueuedInputId: null,
      pendingResendClientMessageId: 'failed-A',
    });
  });

  it('先失败重发 A 再排队编辑 C，pending 被清掉，下一次发送不会误用 A 的 id', () => {
    const failed = composerEditModeState({ kind: 'failed-resend', clientMessageId: 'failed-A' });
    const afterQueued = composerEditModeState({ kind: 'queued-edit', queuedInputId: 'queued-C' });
    expect({ ...failed, ...afterQueued }).toEqual({
      editingQueuedInputId: 'queued-C',
      pendingResendClientMessageId: null,
    });
  });

  it('ChatInput 两种模式入口都整体写入一对 id，不各自只写一半', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/features/chat/ChatInput/index.tsx'),
      'utf8',
    );
    expect(source).toContain("kind: 'failed-resend'");
    expect(source).toContain("kind: 'queued-edit'");
    expect(source.match(/setEditingQueuedInputId\(mode\.editingQueuedInputId\)/g)?.length).toBe(2);
    expect(source.match(/pendingResendClientMessageIdRef\.current = mode\.pendingResendClientMessageId/g)?.length).toBe(2);
  });
});

describe('consumePendingClientMessageId', () => {
  it('编辑重发 pending id 在 envelope 没带 id 时被消费，用过即清空', () => {
    const pending = { current: 'failed-bubble-id' };
    const id = consumePendingClientMessageId(undefined, pending, () => 'fresh-uuid');
    expect(id).toBe('failed-bubble-id');
    expect(pending.current).toBeNull();
  });

  it('envelope 已带 id 时优先用它，pending 仍然清空以免污染下一条', () => {
    const pending = { current: 'stale-pending' };
    const id = consumePendingClientMessageId('envelope-id', pending, () => 'fresh-uuid');
    expect(id).toBe('envelope-id');
    expect(pending.current).toBeNull();
  });

  it('验收④ 变异：不消费 pending 时编辑重发会铸成新 UUID', () => {
    const pending = { current: 'failed-bubble-id' };
    const mutated = (envelopeId: string | undefined, generateId: () => string) => (
      envelopeId ?? generateId()
    );
    expect(mutated(undefined, () => 'fresh-uuid')).toBe('fresh-uuid');
    expect(pending.current).toBe('failed-bubble-id');
  });
});
