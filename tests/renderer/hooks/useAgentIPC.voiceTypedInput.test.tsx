// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEnvelope } from '../../../src/shared/contract/conversationEnvelope';
import { QueuedInputSchemas, VoiceSchemas } from '../../../src/shared/ipc/schemas';

const invokeMock = vi.hoisted(() => vi.fn());
const typedInvokeDomainMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: invokeMock },
}));

vi.mock('../../../src/renderer/services/typedInvoke', () => ({
  typedInvokeDomain: typedInvokeDomainMock,
}));

import { useAgentIPC, type QueuedRuntimeInput } from '../../../src/renderer/hooks/agent/useAgentIPC';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';
import { useVoiceCallStore } from '../../../src/renderer/stores/voiceCallStore';

const SESSION_ID = 'session-voice-typed';
const envelope: ConversationEnvelope = {
  content: '别等了，改做 Y',
  sessionId: SESSION_ID,
};

type QueueRequest = {
  payload: {
    id: string;
    sessionId: string;
    envelope: ConversationEnvelope;
  };
};

function queueResponse(request: QueueRequest) {
  return {
    success: true,
    data: {
      id: request.payload.id,
      sessionId: request.payload.sessionId,
      envelope: request.payload.envelope,
      status: 'queued' as const,
      retryCount: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    },
  };
}

function setBusySession(): void {
  useAppStore.setState({
    isProcessing: true,
    processingSessionIds: new Set([SESSION_ID]),
  });
  useTaskStore.setState({
    sessionStates: { [SESSION_ID]: { status: 'running' } },
  });
}

function setLiveVoiceCall(): void {
  useVoiceCallStore.setState({
    phase: 'live',
    sessionId: SESSION_ID,
  });
}

function renderSendHook(enqueueRuntimeInput: (input: QueuedRuntimeInput) => void) {
  return renderHook(() => useAgentIPC({
    addMessage: useSessionStore.getState().addMessage,
    currentSessionId: SESSION_ID,
    currentTurnMessageIdRef: { current: null },
    enqueueRuntimeInput,
    isProcessing: true,
    setIsProcessing: vi.fn(),
    setSessionProcessing: useAppStore.getState().setSessionProcessing,
  }));
}

describe('useAgentIPC busy typed input during a voice call', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    typedInvokeDomainMock.mockReset();
    useSessionStore.setState({ currentSessionId: SESSION_ID, messages: [] });
    useAppStore.setState({ isProcessing: false, processingSessionIds: new Set<string>() });
    useTaskStore.setState({ sessionStates: { [SESSION_ID]: { status: 'idle' } } });
    useVoiceCallStore.getState().reset();
  });

  it('live voice + busy session injects text and does not create a queued input', async () => {
    setBusySession();
    setLiveVoiceCall();
    typedInvokeDomainMock.mockResolvedValueOnce({
      success: true,
      data: { outcome: 'injected' },
    });
    const enqueueRuntimeInput = vi.fn<(input: QueuedRuntimeInput) => void>();
    const hook = renderSendHook(enqueueRuntimeInput);

    await act(async () => {
      await hook.result.current.sendMessage(envelope);
    });

    expect(typedInvokeDomainMock).toHaveBeenCalledWith(
      VoiceSchemas.INJECT_USER_TEXT,
      {
        action: 'injectUserText',
        payload: { neoSessionId: SESSION_ID, text: envelope.content },
      },
    );
    expect(typedInvokeDomainMock).toHaveBeenCalledTimes(1);
    expect(enqueueRuntimeInput).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('busy session outside a voice call keeps the existing queue path', async () => {
    setBusySession();
    const enqueueRuntimeInput = vi.fn<(input: QueuedRuntimeInput) => void>();
    typedInvokeDomainMock.mockImplementationOnce(async (_schema: unknown, request: QueueRequest) => (
      queueResponse(request)
    ));
    const hook = renderSendHook(enqueueRuntimeInput);

    await act(async () => {
      await hook.result.current.sendMessage(envelope);
    });

    expect(typedInvokeDomainMock).toHaveBeenCalledWith(
      QueuedInputSchemas.ENQUEUE,
      expect.objectContaining({ action: 'enqueue' }),
    );
    expect(typedInvokeDomainMock).not.toHaveBeenCalledWith(
      VoiceSchemas.INJECT_USER_TEXT,
      expect.anything(),
    );
    expect(enqueueRuntimeInput).toHaveBeenCalledTimes(1);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('a rejected voice injection falls back to the durable queue exactly once', async () => {
    setBusySession();
    setLiveVoiceCall();
    const enqueueRuntimeInput = vi.fn<(input: QueuedRuntimeInput) => void>();
    typedInvokeDomainMock
      .mockResolvedValueOnce({
        success: true,
        data: { outcome: 'fallback', reason: 'injection_rejected' },
      })
      .mockImplementationOnce(async (_schema: unknown, request: QueueRequest) => (
        queueResponse(request)
      ));
    const hook = renderSendHook(enqueueRuntimeInput);

    await act(async () => {
      await hook.result.current.sendMessage(envelope);
    });

    expect(typedInvokeDomainMock).toHaveBeenNthCalledWith(
      1,
      VoiceSchemas.INJECT_USER_TEXT,
      expect.objectContaining({ action: 'injectUserText' }),
    );
    expect(typedInvokeDomainMock).toHaveBeenNthCalledWith(
      2,
      QueuedInputSchemas.ENQUEUE,
      expect.objectContaining({ action: 'enqueue' }),
    );
    expect(enqueueRuntimeInput).toHaveBeenCalledTimes(1);
    expect(enqueueRuntimeInput.mock.calls[0]?.[0].content).toBe(envelope.content);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('a hangup race returns the text to the queue without starting a text round or duplicating it', async () => {
    setBusySession();
    setLiveVoiceCall();
    const enqueueRuntimeInput = vi.fn<(input: QueuedRuntimeInput) => void>();
    let releaseInjection!: (result: unknown) => void;
    typedInvokeDomainMock.mockImplementationOnce(() => new Promise((resolve) => {
      releaseInjection = resolve;
    }));
    typedInvokeDomainMock.mockImplementationOnce(async (_schema: unknown, request: QueueRequest) => (
      queueResponse(request)
    ));
    const hook = renderSendHook(enqueueRuntimeInput);

    let sendPromise!: Promise<void>;
    await act(async () => {
      sendPromise = hook.result.current.sendMessage(envelope);
      await Promise.resolve();
      useVoiceCallStore.getState().reset();
      releaseInjection({
        success: true,
        data: { outcome: 'fallback', reason: 'no_active_call' },
      });
      await sendPromise;
    });

    expect(enqueueRuntimeInput).toHaveBeenCalledTimes(1);
    expect(typedInvokeDomainMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('tools-unavailable fallback preserves the typed text instead of swallowing it', async () => {
    setBusySession();
    setLiveVoiceCall();
    const enqueueRuntimeInput = vi.fn<(input: QueuedRuntimeInput) => void>();
    typedInvokeDomainMock
      .mockResolvedValueOnce({
        success: true,
        data: { outcome: 'fallback', reason: 'tools_unavailable' },
      })
      .mockImplementationOnce(async (_schema: unknown, request: QueueRequest) => (
        queueResponse(request)
      ));
    const hook = renderSendHook(enqueueRuntimeInput);

    await act(async () => {
      await hook.result.current.sendMessage(envelope);
    });

    expect(enqueueRuntimeInput).toHaveBeenCalledTimes(1);
    expect(enqueueRuntimeInput.mock.calls[0]?.[0].content).toBe(envelope.content);
  });
});
