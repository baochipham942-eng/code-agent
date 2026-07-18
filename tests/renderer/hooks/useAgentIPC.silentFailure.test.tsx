// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEnvelope } from '../../../src/shared/contract/conversationEnvelope';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: invokeMock,
  },
}));

import { useAgentIPC } from '../../../src/renderer/hooks/agent/useAgentIPC';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useSwarmStore } from '../../../src/renderer/stores/swarmStore';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';

const envelope: ConversationEnvelope = {
  content: '排队到下一轮的消息',
  sessionId: 'session-queued',
};

function renderSendHook() {
  return renderHook(() => useAgentIPC({
    addMessage: useSessionStore.getState().addMessage,
    currentSessionId: 'session-queued',
    currentTurnMessageIdRef: { current: null },
    enqueueRuntimeInput: vi.fn(),
    isProcessing: false,
    setIsProcessing: vi.fn(),
    setSessionProcessing: useAppStore.getState().setSessionProcessing,
  }));
}

describe('useAgentIPC sendMessage silentFailure', () => {
  beforeEach(() => {
    invokeMock.mockReset();
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
});
