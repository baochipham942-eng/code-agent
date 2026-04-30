/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const compactMocks = vi.hoisted(() => {
  const state = {
    currentSessionId: 'session-1',
    persistedMessages: [] as any[],
  };
  const handlers = new Map<string, (event: unknown, ...args: any[]) => Promise<unknown>>();
  const sessionManager = {
    getCurrentSessionId: vi.fn(() => state.currentSessionId),
    getMessages: vi.fn(async () => state.persistedMessages),
    replaceMessages: vi.fn(async (_sessionId: string, messages: any[]) => {
      state.persistedMessages = messages;
    }),
  };
  const database = {
    getDb: vi.fn(() => null),
    getSession: vi.fn(() => null),
    getMessages: vi.fn(() => state.persistedMessages),
    saveSessionRuntimeState: vi.fn(),
  };
  return {
    state,
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (event: unknown, ...args: any[]) => Promise<unknown>) => {
        handlers.set(channel, handler);
      }),
    },
    sessionManager,
    database,
    compactModelSummarize: vi.fn(async () => '压缩摘要'),
  };
});

vi.mock('../../../src/main/platform', () => ({
  ipcMain: compactMocks.ipcMain,
  BrowserWindow: class MockBrowserWindow {},
}));

vi.mock('../../../src/main/services', () => ({
  getSessionManager: () => compactMocks.sessionManager,
}));

vi.mock('../../../src/main/services/core/databaseService', () => ({
  getDatabase: () => compactMocks.database,
}));

vi.mock('../../../src/main/context/compactModel', () => ({
  compactModelSummarize: compactMocks.compactModelSummarize,
}));

import { registerContextHealthHandlers, resolveContextHealthForSession } from '../../../src/main/ipc/contextHealth.ipc';
import { getContextHealthService } from '../../../src/main/context/contextHealthService';
import { initAutoCompressor } from '../../../src/main/context/autoCompressor';
import { getSessionStateManager } from '../../../src/main/session/sessionStateManager';
import { DEFAULT_MODEL, getContextWindow } from '../../../src/shared/constants';
import type { AgentApplicationService } from '../../../src/shared/contract/appService';
import type { CompactResult } from '../../../src/shared/contract/contextHealth';
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
    vi.clearAllMocks();
    getContextHealthService().clear();
    getSessionStateManager().clear();
    compactMocks.handlers.clear();
    initAutoCompressor({ preserveRecentCount: 10 });
    compactMocks.state.currentSessionId = 'session-1';
    compactMocks.state.persistedMessages = [];
    compactMocks.compactModelSummarize.mockResolvedValue('压缩摘要');
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

  it('includes assistant tool call arguments when deriving context health', async () => {
    const sessionId = 'session-with-tool-calls';
    const messages: Message[] = [
      {
        id: 'm1',
        role: 'user',
        content: '请读取一批文件并整理结果。',
        timestamp: 1,
      },
      {
        id: 'm2',
        role: 'assistant',
        content: '',
        timestamp: 2,
        toolCalls: [
          {
            id: 'call-1',
            name: 'Read',
            arguments: {
              file_path: '/Users/linchen/Downloads/ai/code-agent/src/main/context/contextHealthService.ts',
              note: 'tool call arguments should count toward context usage '.repeat(120),
            },
          },
        ],
      },
    ];

    const health = await resolveContextHealthForSession(
      { getAppService: () => makeAppService(sessionId, messages, DEFAULT_MODEL) },
      sessionId,
    );

    expect(health.breakdown.messages).toBeGreaterThan(1000);
    expect(health.currentTokens).toBe(health.breakdown.messages);
  });

  it('includes the last persisted system prompt when deriving history health', async () => {
    const sessionId = 'session-with-system-prompt';
    const messages: Message[] = [
      {
        id: 'm1',
        role: 'user',
        content: '只回复 OK。'.repeat(40),
        timestamp: 1,
      },
    ];
    const systemPrompt = '系统提示词也属于真实上下文，历史会话回看时不能漏掉。'.repeat(120);

    const health = await resolveContextHealthForSession(
      {
        getAppService: () => makeAppService(sessionId, messages, DEFAULT_MODEL),
        getSystemPromptForSession: () => systemPrompt,
      },
      sessionId,
    );

    expect(health.breakdown.systemPrompt).toBeGreaterThan(0);
    expect(health.currentTokens).toBe(health.breakdown.systemPrompt + health.breakdown.messages);
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

  it('compacts the current session through IPC and persists a compaction block', async () => {
    const sessionId = 'session-compact-current';
    const messages: Message[] = Array.from({ length: 14 }, (_, index) => ({
      id: `m${index + 1}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `历史消息 ${index + 1}\n${'这是一段需要被压缩的长上下文。'.repeat(260)}`,
      timestamp: index + 1,
    }));
    const appService = makeAppService(sessionId, messages, DEFAULT_MODEL);
    const setMessages = vi.fn();
    const taskManager = {
      getOrchestrator: vi.fn(() => ({ setMessages })),
    };

    registerContextHealthHandlers({
      getAppService: () => appService,
      getTaskManager: () => taskManager as any,
      getSystemPromptForSession: () => '',
    });

    const handler = compactMocks.handlers.get('context:compact-current');
    expect(handler).toBeDefined();

    const result = await handler!({}, sessionId) as CompactResult;

    expect(result.success).toBe(true);
    expect(result.savedTokens).toBeGreaterThan(0);
    expect(compactMocks.sessionManager.replaceMessages).toHaveBeenCalledWith(
      sessionId,
      expect.any(Array),
    );
    expect(compactMocks.state.persistedMessages.some((message) => message.compaction?.type === 'compaction')).toBe(true);
    expect(compactMocks.database.saveSessionRuntimeState).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ compressionStateJson: expect.any(String) }),
    );
    expect(setMessages).toHaveBeenCalledWith(compactMocks.state.persistedMessages);
    expect(getContextHealthService().get(sessionId).currentTokens).toBeGreaterThan(0);
    expect(getContextHealthService().get(sessionId).currentTokens).toBeLessThan(result.beforeTokens);
  });
});
