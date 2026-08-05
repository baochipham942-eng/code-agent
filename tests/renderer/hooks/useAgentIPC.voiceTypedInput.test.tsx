// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEnvelope } from '../../../src/shared/contract/conversationEnvelope';
import { VoiceSchemas } from '../../../src/shared/ipc/schemas';

const invokeMock = vi.hoisted(() => vi.fn());
const invokeDomainMock = vi.hoisted(() => vi.fn());
const typedInvokeDomainMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: invokeMock, invokeDomain: invokeDomainMock },
}));

vi.mock('../../../src/renderer/services/typedInvoke', () => ({
  typedInvokeDomain: typedInvokeDomainMock,
}));

import { useAgentIPC } from '../../../src/renderer/hooks/agent/useAgentIPC';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';
import { useVoiceCallStore } from '../../../src/renderer/stores/voiceCallStore';

const SESSION_ID = 'session-voice-typed';
const envelope: ConversationEnvelope = { content: '别等了，改做 Y', sessionId: SESSION_ID };

function setBusySession(): void {
  useAppStore.setState({ isProcessing: true, processingSessionIds: new Set([SESSION_ID]) });
  useTaskStore.setState({ sessionStates: { [SESSION_ID]: { status: 'running' } } });
}

function setLiveVoiceCall(): void {
  useVoiceCallStore.setState({ phase: 'live', sessionId: SESSION_ID });
}

function renderSendHook() {
  return renderHook(() => useAgentIPC({
    addMessage: useSessionStore.getState().addMessage,
    currentSessionId: SESSION_ID,
    currentTurnMessageIdRef: { current: null },
    isProcessing: true,
    setIsProcessing: vi.fn(),
    setSessionProcessing: useAppStore.getState().setSessionProcessing,
  }));
}

describe('useAgentIPC busy typed input during a voice call', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeDomainMock.mockReset().mockResolvedValue({ outcome: 'steered' });
    typedInvokeDomainMock.mockReset();
    useSessionStore.setState({ currentSessionId: SESSION_ID, messages: [] });
    useAppStore.setState({ isProcessing: false, processingSessionIds: new Set<string>() });
    useTaskStore.setState({ sessionStates: { [SESSION_ID]: { status: 'idle' } } });
    useVoiceCallStore.getState().reset();
  });

  it('injects text into a live voice call without starting text delivery', async () => {
    setBusySession();
    setLiveVoiceCall();
    typedInvokeDomainMock.mockResolvedValueOnce({ success: true, data: { outcome: 'injected' } });
    const hook = renderSendHook();

    await act(async () => hook.result.current.sendMessage(envelope));

    expect(typedInvokeDomainMock).toHaveBeenCalledWith(VoiceSchemas.INJECT_USER_TEXT, {
      action: 'injectUserText',
      payload: { neoSessionId: SESSION_ID, text: envelope.content },
    });
    expect(invokeDomainMock).not.toHaveBeenCalled();
  });

  it('delivers busy text outside a voice call to the foreground brain', async () => {
    setBusySession();
    const hook = renderSendHook();

    await act(async () => hook.result.current.sendMessage(envelope));

    expect(typedInvokeDomainMock).not.toHaveBeenCalledWith(VoiceSchemas.INJECT_USER_TEXT, expect.anything());
    expect(invokeDomainMock).toHaveBeenCalledWith(
      'domain:agent',
      'interrupt',
      expect.objectContaining({ content: envelope.content, sessionId: SESSION_ID }),
    );
  });

  it.each(['injection_rejected', 'no_active_call', 'tools_unavailable'])(
    'routes voice fallback %s to foreground input delivery exactly once',
    async (reason) => {
      setBusySession();
      setLiveVoiceCall();
      typedInvokeDomainMock.mockResolvedValueOnce({
        success: true,
        data: { outcome: 'fallback', reason },
      });
      const hook = renderSendHook();

      await act(async () => hook.result.current.sendMessage(envelope));

      expect(typedInvokeDomainMock).toHaveBeenCalledTimes(1);
      expect(invokeDomainMock).toHaveBeenCalledTimes(1);
      expect(useSessionStore.getState().messages.at(-1)).toMatchObject({
        role: 'user',
        content: envelope.content,
      });
      expect(invokeMock).not.toHaveBeenCalled();
    },
  );
});
