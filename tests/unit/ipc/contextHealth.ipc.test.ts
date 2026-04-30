import { describe, it, expect, beforeEach } from 'vitest';
import { resolveContextHealthForSession } from '../../../src/main/ipc/contextHealth.ipc';
import { getContextHealthService } from '../../../src/main/context/contextHealthService';
import { getSessionStateManager } from '../../../src/main/session/sessionStateManager';
import { DEFAULT_MODEL, getContextWindow } from '../../../src/shared/constants';
import type { AgentApplicationService } from '../../../src/shared/contract/appService';
import type { Message } from '../../../src/shared/contract';

function makeAppService(sessionId: string, messages: Message[], modelOverride?: string): AgentApplicationService {
  return {
    getMessages: async () => messages,
    getSerializedCompressionState: () => null,
    getCurrentSessionId: () => sessionId,
    sendMessage: async () => {},
    cancel: async () => {},
    handlePermissionResponse: () => {},
    interruptAndContinue: async () => {},
    getWorkingDirectory: () => undefined,
    setWorkingDirectory: () => {},
    createSession: async () => { throw new Error('not implemented'); },
    loadSession: async () => { throw new Error('not implemented'); },
    deleteSession: async () => {},
    listSessions: async () => [],
    updateSession: async () => {},
    archiveSession: async () => null,
    unarchiveSession: async () => null,
    loadOlderMessages: async () => ({ messages: [], hasMore: false }),
    exportSession: async () => null,
    exportSessionMarkdown: async () => ({ markdown: '', suggestedFileName: 'session.md' }),
    importSession: async () => sessionId,
    setCurrentSessionId: () => {},
    getMemoryContext: async () => null,
    switchModel: () => {},
    getModelOverride: () => modelOverride ? {
      provider: 'openai',
      model: modelOverride,
    } : undefined,
    clearModelOverride: () => {},
    setDelegateMode: () => {},
    isDelegateMode: () => false,
    setEffortLevel: () => {},
    setInteractionMode: () => {},
    pause: () => {},
    resume: () => {},
  };
}

describe('resolveContextHealthForSession', () => {
  beforeEach(() => {
    getContextHealthService().clear();
    getSessionStateManager().clear();
  });

  it('derives context health from persisted messages when runtime health is empty', async () => {
    const sessionId = 'session-with-history';
    const messages: Message[] = [
      {
        id: 'm1',
        role: 'user',
        content: '帮我检查这个历史会话的上下文统计。'.repeat(80),
        timestamp: 1,
      },
      {
        id: 'm2',
        role: 'assistant',
        content: '这是已经存在的历史回复，切换会话时也应该计入上下文。'.repeat(80),
        timestamp: 2,
      },
    ];

    const health = await resolveContextHealthForSession(
      { getAppService: () => makeAppService(sessionId, messages, DEFAULT_MODEL) },
      sessionId,
    );

    expect(health.currentTokens).toBeGreaterThan(0);
    expect(health.breakdown.messages).toBeGreaterThan(0);
    expect(health.maxTokens).toBe(getContextWindow(DEFAULT_MODEL));
    expect(getContextHealthService().get(sessionId).currentTokens).toBe(health.currentTokens);
    expect(getSessionStateManager().getSummary(sessionId)?.contextHealth.currentTokens).toBe(health.currentTokens);
  });

  it('uses the session model override when estimating max context window', async () => {
    const sessionId = 'session-with-model';
    const messages: Message[] = [
      {
        id: 'm1',
        role: 'user',
        content: '模型窗口也要按当前会话来算。',
        timestamp: 1,
      },
    ];

    const health = await resolveContextHealthForSession(
      { getAppService: () => makeAppService(sessionId, messages, 'gpt-5.5') },
      sessionId,
    );

    expect(health.maxTokens).toBe(getContextWindow('gpt-5.5'));
  });
});
