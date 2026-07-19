// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const steerMocks = vi.hoisted(() => ({
  toastInfo: vi.fn(),
}));

vi.mock('../../../src/renderer/hooks/useToast', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/renderer/hooks/useToast')>();
  return {
    ...original,
    toast: {
      ...original.toast,
      info: steerMocks.toastInfo,
    },
  };
});

import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { handleQueuedSteerOutcome } from '../../../src/renderer/components/ChatView';
import { submitSteerEnvelope } from '../../../src/renderer/components/features/chat/chatViewSteer';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

describe('ChatView mid-turn adjustment boundary', () => {
  const invoke = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState({
      currentSessionId: 'session-running',
      messages: [],
      streamSnapshot: null,
    });
    window.codeAgentDomainAPI = { invoke } as typeof window.codeAgentDomainAPI;
    window.domainAPI = undefined;
  });

  afterEach(() => {
    window.codeAgentDomainAPI = undefined;
    window.domainAPI = undefined;
  });

  it('uses the desktop domain bridge and projects a steered message through sessionStore', async () => {
    invoke.mockResolvedValue({ success: true, data: { outcome: 'steered' } });
    const hydrate = vi.fn();

    const outcome = await submitSteerEnvelope(
      {
        content: '改用简洁方案',
        attachments: [],
        context: {
          workingDirectory: '/repo',
          runtimeInput: { mode: 'supplement' },
        },
      },
      'session-running',
      vi.fn().mockResolvedValue(undefined),
    );

    expect(outcome).toEqual({ outcome: 'steered' });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      IPC_DOMAINS.AGENT,
      'interrupt',
      expect.objectContaining({
        content: '改用简洁方案',
        sessionId: 'session-running',
        clientMessageId: expect.any(String),
      }),
    );
    const payload = invoke.mock.calls[0][2];
    expect(useSessionStore.getState().messages).toContainEqual(expect.objectContaining({
      id: payload.clientMessageId,
      role: 'user',
      content: '改用简洁方案',
      attachments: [],
      metadata: {
        workbench: {
          workingDirectory: '/repo',
          runtimeInputMode: 'supplement',
        },
      },
    }));
    expect(hydrate).not.toHaveBeenCalled();
  });

  it('shows queued feedback and rehydrates renderer queue state after fallback', async () => {
    invoke.mockResolvedValue({
      success: true,
      data: { outcome: 'queued', queuedInputId: 'queued-1' },
    });
    const hydrate = vi.fn().mockResolvedValue(undefined);
    const queuedToastMessage = '这轮刚好结束，已排到下一轮';

    const outcome = await submitSteerEnvelope(
      { content: '改用简洁方案', clientMessageId: 'client-1' },
      'session-running',
      () => handleQueuedSteerOutcome('session-running', hydrate, queuedToastMessage),
    );

    expect(outcome).toEqual({ outcome: 'queued', queuedInputId: 'queued-1' });
    expect(steerMocks.toastInfo).toHaveBeenCalledWith(queuedToastMessage);
    expect(hydrate).toHaveBeenCalledWith('session-running');
    expect(useSessionStore.getState().messages).toEqual([]);
  });
});
