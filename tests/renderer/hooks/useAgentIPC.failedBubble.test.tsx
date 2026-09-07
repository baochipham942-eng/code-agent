// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEnvelope } from '../../../src/shared/contract/conversationEnvelope';
import type { MessageAttachment } from '../../../src/shared/contract';

const invokeMock = vi.hoisted(() => vi.fn());
const invokeDomainMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: invokeMock,
    invokeDomain: invokeDomainMock,
  },
}));

import { useAgentIPC } from '../../../src/renderer/hooks/agent/useAgentIPC';
import { applyConversationStreamEvent } from '../../../src/renderer/hooks/agent/effects/useConversationStreamEffects';
import type { Message } from '../../../src/shared/contract';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useSwarmStore } from '../../../src/renderer/stores/swarmStore';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';

const envelope: ConversationEnvelope = {
  content: '一段很长的需求说明，失败后必须还能看见',
  sessionId: 'session-failed-bubble',
  clientMessageId: 'client-msg-keep',
};

function renderSendHook() {
  return renderHook(() => useAgentIPC({
    addMessage: useSessionStore.getState().addMessage,
    currentSessionId: 'session-failed-bubble',
    currentTurnMessageIdRef: { current: null },
    isProcessing: false,
    setIsProcessing: vi.fn(),
    setSessionProcessing: useAppStore.getState().setSessionProcessing,
  }));
}

function userMessages() {
  return useSessionStore.getState().messages.filter((message) => message.role === 'user');
}

function hostClientMessageIds(): string[] {
  return invokeMock.mock.calls.map((call) => {
    const payload = call[1] as { clientMessageId?: string };
    return payload.clientMessageId ?? '';
  });
}

describe('useAgentIPC 失败气泡保留 + clientMessageId 幂等', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeDomainMock.mockReset();
    useSessionStore.setState({
      currentSessionId: 'session-failed-bubble',
      messages: [],
    });
    useSwarmStore.getState().reset();
    useAppStore.setState({
      isProcessing: false,
      processingSessionIds: new Set<string>(),
    });
    useTaskStore.setState({
      sessionStates: {
        'session-failed-bubble': { status: 'idle' },
      },
    });
  });

  it('发送失败后原用户消息留在时间线并标记 sendFailed', async () => {
    invokeMock.mockRejectedValueOnce(new Error('network down'));
    const hook = renderSendHook();

    await act(async () => {
      await hook.result.current.sendMessage(envelope);
    });

    const users = userMessages();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      id: 'client-msg-keep',
      content: '一段很长的需求说明，失败后必须还能看见',
      metadata: expect.objectContaining({ sendFailed: true }),
    });
    const assistant = useSessionStore.getState().messages.find((message) => message.role === 'assistant');
    expect(assistant?.metadata).toMatchObject({
      retryPrompt: '一段很长的需求说明，失败后必须还能看见',
      retryClientMessageId: 'client-msg-keep',
      retrySessionId: 'session-failed-bubble',
    });
  });

  it('同 clientMessageId 连续重发不产生第二条气泡、不产生并发第二条 host 提交', async () => {
    invokeMock.mockRejectedValueOnce(new Error('network down'));
    const hook = renderSendHook();

    await act(async () => {
      await hook.result.current.sendMessage(envelope);
    });
    expect(userMessages()).toHaveLength(1);
    expect(userMessages()[0]?.metadata?.sendFailed).toBe(true);

    invokeMock.mockReset();
    let release!: () => void;
    invokeMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      release = resolve;
    }));

    let firstRetry!: Promise<unknown>;
    let secondRetry!: Promise<unknown>;
    await act(async () => {
      firstRetry = hook.result.current.sendMessage(envelope);
      secondRetry = hook.result.current.sendMessage(envelope);
      await Promise.resolve();
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);

    release();
    const deliveries = await Promise.all([firstRetry, secondRetry]);
    expect(deliveries).toEqual([{ outcome: 'sent' }, { outcome: 'sent' }]);
    expect(userMessages()).toHaveLength(1);
    expect(userMessages()[0]?.id).toBe('client-msg-keep');
    expect(userMessages()[0]?.metadata?.sendFailed).toBeUndefined();
    expect(new Set(hostClientMessageIds())).toEqual(new Set(['client-msg-keep']));
  });

  it('编辑后同 id 替换重发：正文和附件更新在原气泡上', async () => {
    invokeMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(undefined);
    const hook = renderSendHook();
    const attachment = { id: 'att-1', name: 'a.png', type: 'image', size: 1 } as MessageAttachment;

    await act(async () => {
      await hook.result.current.sendMessage({
        ...envelope,
        attachments: [attachment],
      });
    });

    await act(async () => {
      await hook.result.current.sendMessage({
        ...envelope,
        content: '改过的需求',
        attachments: [attachment],
      });
    });

    const users = userMessages();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      id: 'client-msg-keep',
      content: '改过的需求',
      attachments: [attachment],
    });
    expect(users[0]?.metadata?.sendFailed).toBeUndefined();
  });

  it('验收④ 变异：重试不携带原 clientMessageId 时出现第二条气泡和第二条 host 提交', async () => {
    invokeMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(undefined);
    const hook = renderSendHook();

    await act(async () => {
      await hook.result.current.sendMessage(envelope);
    });
    expect(userMessages()).toHaveLength(1);

    const mutatedRetry: ConversationEnvelope = {
      content: envelope.content,
      sessionId: envelope.sessionId,
      // 变异：故意不带原 clientMessageId，模拟旧的错误卡重试路径。
    };
    await act(async () => {
      await hook.result.current.sendMessage(mutatedRetry);
    });

    const users = userMessages();
    // 下面这组断言是生产路径「1 条气泡 / 同一 clientMessageId」的镜像。
    // 拿掉幂等环后它们不成立——气泡变成 2 条、host 两次用了不同 id。
    expect(users).toHaveLength(2);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(new Set(hostClientMessageIds()).size).toBe(2);
    expect(hostClientMessageIds()[0]).toBe('client-msg-keep');
    expect(hostClientMessageIds()[1]).not.toBe('client-msg-keep');
  });

  it('host 回放同 id 用户消息时更新失败气泡正文并清失败态', () => {
    const messagesRef = {
      current: [{
        id: 'client-msg-keep',
        role: 'user',
        content: '原文 A',
        timestamp: 1,
        metadata: { sendFailed: true },
      }] as Message[],
    };
    applyConversationStreamEvent(
      {
        type: 'message',
        data: {
          id: 'client-msg-keep',
          role: 'user',
          content: '改过的需求 B',
          timestamp: 2,
        },
      },
      {
        currentTurnMessageId: null,
        committedAssistantMessageIds: new Set<string>(),
        lastDeltaSeqByTurn: new Map<string, number>(),
      },
      {
        addMessage: (message) => {
          messagesRef.current = [...messagesRef.current, message];
        },
        updateMessage: (id, updates) => {
          messagesRef.current = messagesRef.current.map((message) => (
            message.id === id ? { ...message, ...updates } : message
          ));
        },
        setMessages: (next) => {
          messagesRef.current = next;
        },
        getMessages: () => messagesRef.current,
        queueUpdate: () => {},
        now: () => 500,
        generateId: () => 'generated',
      },
    );

    expect(messagesRef.current).toHaveLength(1);
    expect(messagesRef.current[0]).toMatchObject({
      id: 'client-msg-keep',
      content: '改过的需求 B',
    });
    expect(messagesRef.current[0]?.metadata?.sendFailed).toBeUndefined();
  });

  it('运行中重试保留原 clientMessageId，并替换同 id 失败气泡', async () => {
    useSessionStore.setState({
      currentSessionId: 'session-failed-bubble',
      messages: [{
        id: 'client-msg-keep',
        role: 'user',
        content: '原文 A',
        timestamp: 1,
        metadata: { sendFailed: true },
      }],
    });
    useAppStore.setState({
      isProcessing: true,
      processingSessionIds: new Set(['session-failed-bubble']),
    });
    useTaskStore.setState({
      sessionStates: {
        'session-failed-bubble': { status: 'running' },
      },
    });
    invokeDomainMock.mockResolvedValueOnce({ outcome: 'steered' });
    const hook = renderSendHook();

    await act(async () => {
      await hook.result.current.sendMessage({
        ...envelope,
        content: '改过的需求 B',
        clientMessageId: 'client-msg-keep',
      });
    });

    expect(invokeDomainMock).toHaveBeenCalledWith(
      'domain:agent',
      'interrupt',
      expect.objectContaining({
        clientMessageId: 'client-msg-keep',
        content: '改过的需求 B',
      }),
    );
    expect(invokeMock).not.toHaveBeenCalled();
    const users = userMessages();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      id: 'client-msg-keep',
      content: '改过的需求 B',
    });
    expect(users[0]?.metadata?.sendFailed).toBeUndefined();
  });
});
