// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEnvelope } from '../../../src/shared/contract/conversationEnvelope';
import { QueuedInputSchemas } from '../../../src/shared/ipc/schemas';

const invokeMock = vi.hoisted(() => vi.fn());
const typedInvokeDomainMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: invokeMock,
  },
}));

vi.mock('../../../src/renderer/services/typedInvoke', () => ({
  typedInvokeDomain: typedInvokeDomainMock,
}));

import {
  useAgentIPC,
  type QueuedRuntimeInput,
} from '../../../src/renderer/hooks/agent/useAgentIPC';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useSwarmStore } from '../../../src/renderer/stores/swarmStore';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';

const envelope: ConversationEnvelope = {
  content: '排队到下一轮的消息',
  sessionId: 'session-queued',
};

function renderSendHook(options?: {
  enqueueRuntimeInput?: (input: QueuedRuntimeInput) => void;
  isProcessing?: boolean;
}) {
  return renderHook(() => useAgentIPC({
    addMessage: useSessionStore.getState().addMessage,
    currentSessionId: 'session-queued',
    currentTurnMessageIdRef: { current: null },
    enqueueRuntimeInput: options?.enqueueRuntimeInput ?? vi.fn<(input: QueuedRuntimeInput) => void>(),
    isProcessing: options?.isProcessing ?? false,
    setIsProcessing: vi.fn(),
    setSessionProcessing: useAppStore.getState().setSessionProcessing,
  }));
}

describe('useAgentIPC sendMessage silentFailure', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    typedInvokeDomainMock.mockReset();
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

  it('persists a runtime input through the queued input host API before projecting it locally', async () => {
    const enqueueRuntimeInput = vi.fn<(input: QueuedRuntimeInput) => void>();
    const hostCreatedAt = 1_700_000_000_000;
    typedInvokeDomainMock.mockImplementationOnce(async (_schema, request) => ({
      success: true,
      data: {
        id: request.payload.id,
        sessionId: request.payload.sessionId,
        envelope: request.payload.envelope,
        status: 'queued',
        retryCount: 0,
        createdAt: hostCreatedAt,
        updatedAt: hostCreatedAt,
      },
    }));
    useAppStore.setState({
      isProcessing: true,
      processingSessionIds: new Set(['session-queued']),
    });
    const hook = renderSendHook({ enqueueRuntimeInput, isProcessing: true });

    await act(async () => {
      await hook.result.current.sendMessage(envelope);
    });

    expect(typedInvokeDomainMock).toHaveBeenCalledWith(
      QueuedInputSchemas.ENQUEUE,
      {
        action: 'enqueue',
        payload: {
          id: expect.any(String),
          sessionId: 'session-queued',
          envelope: expect.objectContaining({
            content: '排队到下一轮的消息',
            clientMessageId: expect.any(String),
            sessionId: 'session-queued',
            context: expect.objectContaining({
              runtimeInput: {
                mode: 'supplement',
                delivery: 'queued_next_turn',
              },
            }),
          }),
        },
      },
    );
    const request = typedInvokeDomainMock.mock.calls[0]?.[1];
    expect(request.payload.envelope.clientMessageId).toBe(request.payload.id);
    expect(enqueueRuntimeInput).toHaveBeenCalledWith({
      id: request.payload.id,
      sessionId: 'session-queued',
      envelope: request.payload.envelope,
      content: '排队到下一轮的消息',
      mode: 'supplement',
      attachmentsCount: 0,
      createdAt: hostCreatedAt,
      retryCount: 0,
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('adds a visible assistant error when the queued input host API fails', async () => {
    const enqueueRuntimeInput = vi.fn<(input: QueuedRuntimeInput) => void>();
    typedInvokeDomainMock.mockResolvedValueOnce({
      success: false,
      error: { code: 'QUEUED_INPUT_ERROR', message: 'queued input ledger unavailable' },
    });
    useAppStore.setState({
      isProcessing: true,
      processingSessionIds: new Set(['session-queued']),
    });
    const hook = renderSendHook({ enqueueRuntimeInput, isProcessing: true });

    await act(async () => {
      await hook.result.current.sendMessage(envelope);
    });

    expect(enqueueRuntimeInput).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(useSessionStore.getState().messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Error: queued input ledger unavailable',
    });
  });
});
