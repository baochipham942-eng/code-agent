// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEnvelope } from '../../../src/shared/contract/conversationEnvelope';

const invokeMock = vi.hoisted(() => vi.fn());
const invokeDomainMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: invokeMock,
    invokeDomain: invokeDomainMock,
  },
}));

import { useAgentIPC } from '../../../src/renderer/hooks/agent/useAgentIPC';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useSwarmStore } from '../../../src/renderer/stores/swarmStore';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';

const envelope: ConversationEnvelope = {
  content: '运行中补充要求',
  sessionId: 'session-queued',
};

function renderSendHook(options?: { isProcessing?: boolean }) {
  return renderHook(() => useAgentIPC({
    addMessage: useSessionStore.getState().addMessage,
    currentSessionId: 'session-queued',
    currentTurnMessageIdRef: { current: null },
    isProcessing: options?.isProcessing ?? false,
    setIsProcessing: vi.fn(),
    setSessionProcessing: useAppStore.getState().setSessionProcessing,
  }));
}

describe('useAgentIPC sendMessage silentFailure', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeDomainMock.mockReset();
    useSessionStore.setState({
      currentSessionId: 'session-queued',
      messages: [],
    });
    useSwarmStore.getState().reset();
    useAppStore.setState({
      isProcessing: false,
      processingSessionIds: new Set<string>(),
    });
    useTaskStore.setState({
      sessionStates: {
        'session-queued': { status: 'idle' },
      },
    });
  });

  it('rejects without adding an assistant error or leaving the session busy', async () => {
    invokeMock.mockRejectedValueOnce(new Error('session already running'));
    const hook = renderSendHook();

    await act(async () => {
      await expect(
        hook.result.current.sendMessage(envelope, { silentFailure: true }),
      ).rejects.toThrow('session already running');
    });

    expect(
      useSessionStore.getState().messages.filter((message) => message.role === 'assistant'),
    ).toEqual([]);
    expect(useAppStore.getState().isSessionProcessing('session-queued')).toBe(false);
    expect(useTaskStore.getState().sessionStates['session-queued']?.status).toBe('idle');
  });

  it('preserves the existing visible error behavior when silentFailure is omitted', async () => {
    invokeMock.mockRejectedValueOnce(new Error('session already running'));
    const hook = renderSendHook();

    await act(async () => {
      await hook.result.current.sendMessage(envelope);
    });

    const assistantMessages = useSessionStore.getState().messages.filter(
      (message) => message.role === 'assistant',
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.content).toBe('Error: session already running');
    expect(useTaskStore.getState().sessionStates['session-queued']).toEqual({
      status: 'error',
      error: 'Error: session already running',
    });
  });

  it('delivers to the foreground brain when the host says the session still has an active run', async () => {
    invokeMock.mockRejectedValueOnce(
      Object.assign(new Error('云端代理请求失败 (409): Session s already has active run run-x'), { status: 409 }),
    );
    invokeDomainMock.mockResolvedValueOnce({ outcome: 'steered' });
    const hook = renderSendHook();

    await act(async () => {
      await hook.result.current.sendMessage(envelope);
    });

    expect(invokeDomainMock).toHaveBeenCalledWith(
      'domain:agent',
      'interrupt',
      expect.objectContaining({
        content: '运行中补充要求',
        sessionId: 'session-queued',
        context: expect.objectContaining({ runtimeInput: { mode: 'supplement' } }),
      }),
    );
    expect(
      useSessionStore.getState().messages.filter((message) => message.role === 'assistant'),
    ).toEqual([]);
    // 会话不能卡在 running/error，否则后续消息全进排队却没有 run 去消费
    expect(useTaskStore.getState().sessionStates['session-queued']?.status).toBe('idle');
  });

  it('preserves a queued envelope clientMessageId in the host payload', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const hook = renderSendHook();

    await act(async () => {
      await hook.result.current.sendMessage({
        ...envelope,
        clientMessageId: 'queued-message-id',
      });
    });

    expect(invokeMock).toHaveBeenCalledWith(
      'agent:send-message',
      expect.objectContaining({
        clientMessageId: 'queued-message-id',
      }),
    );
  });

  it('projects accepted foreground input without exposing a queue marker', async () => {
    invokeDomainMock.mockResolvedValueOnce({ outcome: 'queued', queuedInputId: 'buffered-input' });
    useAppStore.setState({
      isProcessing: true,
      processingSessionIds: new Set(['session-queued']),
    });
    const hook = renderSendHook({ isProcessing: true });

    await act(async () => {
      await hook.result.current.sendMessage(envelope);
    });

    expect(invokeDomainMock).toHaveBeenCalledWith(
      'domain:agent',
      'interrupt',
      expect.objectContaining({
        content: '运行中补充要求',
        clientMessageId: expect.any(String),
        sessionId: 'session-queued',
        context: expect.objectContaining({ runtimeInput: { mode: 'supplement' } }),
      }),
    );
    expect(useSessionStore.getState().messages.at(-1)).toMatchObject({
      role: 'user',
      content: '运行中补充要求',
      metadata: { workbench: { runtimeInputMode: 'supplement' } },
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('adds a visible assistant error when foreground input delivery fails', async () => {
    invokeDomainMock.mockRejectedValueOnce(new Error('foreground input unavailable'));
    useAppStore.setState({
      isProcessing: true,
      processingSessionIds: new Set(['session-queued']),
    });
    const hook = renderSendHook({ isProcessing: true });

    await act(async () => {
      await hook.result.current.sendMessage(envelope);
    });

    expect(invokeMock).not.toHaveBeenCalled();
    expect(useSessionStore.getState().messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Error: foreground input unavailable',
    });
  });
});
