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

  it.each(['steered', 'queued'] as const)(
    'projects an accepted %s foreground message without queue UI state',
    async (outcomeName) => {
      invoke.mockResolvedValue({
        success: true,
        data: outcomeName === 'steered'
          ? { outcome: 'steered' }
          : { outcome: 'queued', queuedInputId: 'buffered-1' },
      });

      const outcome = await submitSteerEnvelope({
        content: '改用简洁方案',
        attachments: [],
        context: { workingDirectory: '/repo', runtimeInput: { mode: 'supplement' } },
      }, 'session-running');

      expect(outcome?.outcome).toBe(outcomeName);
      expect(invoke).toHaveBeenCalledWith(
        IPC_DOMAINS.AGENT,
        'interrupt',
        expect.objectContaining({ content: '改用简洁方案', sessionId: 'session-running' }),
      );
      expect(useSessionStore.getState().messages.at(-1)).toMatchObject({
        role: 'user',
        content: '改用简洁方案',
        metadata: { workbench: { workingDirectory: '/repo', runtimeInputMode: 'supplement' } },
      });
    },
  );
});
