// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { submitSteerEnvelope } from '../../../src/renderer/components/features/chat/chatViewSteer';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

describe('ChatView mid-turn adjustment boundary', () => {
  const invoke = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState({ currentSessionId: 'session-running', messages: [], streamSnapshot: null });
    window.codeAgentDomainAPI = { invoke } as typeof window.codeAgentDomainAPI;
    window.domainAPI = undefined;
  });

  afterEach(() => {
    window.codeAgentDomainAPI = undefined;
    window.domainAPI = undefined;
  });

  it('optimistically projects an accepted redirect as a normal user bubble', async () => {
      invoke.mockResolvedValue({
        success: true,
        data: { outcome: 'steered' },
      });

      const outcome = await submitSteerEnvelope({
        content: '改用简洁方案',
        attachments: [],
        context: { workingDirectory: '/repo', runtimeInput: { mode: 'redirect' } },
      }, 'session-running', 'turn-visible');

      expect(outcome?.outcome).toBe('steered');
      expect(invoke).toHaveBeenCalledWith(
        IPC_DOMAINS.AGENT,
        'interrupt',
        expect.objectContaining({ content: '改用简洁方案', sessionId: 'session-running', expectedTurnId: 'turn-visible' }),
      );
      expect(useSessionStore.getState().messages).toEqual([
        expect.objectContaining({ role: 'user', content: '改用简洁方案' }),
      ]);
      expect(useSessionStore.getState().messages[0].id).toBe(
        (invoke.mock.calls[0][2] as { clientMessageId: string }).clientMessageId,
      );
  });

  it('removes the optimistic bubble when the redirect races into the durable queue', async () => {
    invoke.mockResolvedValue({
      success: true,
      data: { outcome: 'queued', queuedInputId: 'buffered-1', code: 'TURN_CHANGED', message: '这条先排上了，手头这轮做完就做' },
    });

    const outcome = await submitSteerEnvelope({
      content: '改用简洁方案',
      attachments: [],
      context: { workingDirectory: '/repo', runtimeInput: { mode: 'redirect' } },
    }, 'session-running', 'turn-visible');

    expect(outcome?.outcome).toBe('queued');
    expect(useSessionStore.getState().messages).toEqual([]);
  });
});
