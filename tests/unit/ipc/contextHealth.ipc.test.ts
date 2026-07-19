 
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
  const configService = {
    settings: {
      contextCompression: {
        enabled: true,
        warningThreshold: 0.75,
        criticalThreshold: 0.85,
        preserveRecentCount: 10,
        triggerTokens: 100000,
        compactProvider: 'moonshot',
        compactModel: 'kimi-k2.5',
        auditEnabled: true,
      },
      models: {
        providers: {
          moonshot: { enabled: true },
        },
      },
    },
    getSettings: vi.fn(() => configService.settings),
    updateSettings: vi.fn(async (updates: any) => {
      configService.settings = {
        ...configService.settings,
        ...updates,
      };
    }),
    getApiKey: vi.fn(() => 'test-key'),
  };
  return {
    state,
    handlers,
    ipcHost: {
      handle: vi.fn((channel: string, handler: (event: unknown, ...args: any[]) => Promise<unknown>) => {
        handlers.set(channel, handler);
      }),
    },
    sessionManager,
    database,
    configService,
    compactModelSummarize: vi.fn(async () => '压缩摘要'),
    compactModelSummarizeWithMetadata: vi.fn(async (_prompt: string, _maxTokens: number, _options?: { useMainModel?: boolean; instructions?: string }) => ({
      summary: '压缩摘要',
      metadata: {
        provider: 'moonshot',
        model: 'kimi-k2.5',
        useMainModel: false,
      },
    })),
    resetCompactModel: vi.fn(),
    getCompactModelInfo: vi.fn(() => ({ provider: 'moonshot', model: 'kimi-k2.5' })),
  };
});

vi.mock('../../../src/host/platform', () => ({
  ipcHost: compactMocks.ipcHost,
  AppWindow: class MockBrowserWindow {},
  app: {
    getPath: vi.fn((_name: string) => '/tmp/test-userdata'),
    getVersion: vi.fn(() => '0.0.0-test'),
    getName: vi.fn(() => 'code-agent-test'),
    getAppPath: vi.fn(() => '/tmp/test-app'),
    getLocale: vi.fn(() => 'en-US'),
    isReady: vi.fn(() => true),
    isPackaged: false,
    commandLine: { appendSwitch: vi.fn() },
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
    emit: vi.fn(() => false),
    quit: vi.fn(),
    exit: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    setAppUserModelId: vi.fn(),
    setAsDefaultProtocolClient: vi.fn(() => false),
    setPath: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => compactMocks.sessionManager,
  getConfigService: () => compactMocks.configService,
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => compactMocks.database,
}));

vi.mock('../../../src/host/context/compactModel', () => ({
  compactModelSummarize: compactMocks.compactModelSummarize,
  compactModelSummarizeWithMetadata: compactMocks.compactModelSummarizeWithMetadata,
  resetCompactModel: compactMocks.resetCompactModel,
  getCompactModelInfo: compactMocks.getCompactModelInfo,
}));

import { registerContextHealthHandlers, resolveContextHealthForSession } from '../../../src/host/ipc/contextHealth.ipc';
import { getContextHealthService } from '../../../src/host/context/contextHealthService';
import { initAutoCompressor } from '../../../src/host/context/autoCompressor';
import { getSessionStateManager } from '../../../src/host/session/sessionStateManager';
import { DEFAULT_MODEL, getContextWindow } from '../../../src/shared/constants';
import type { AgentApplicationService } from '../../../src/shared/contract/appService';
import type { CompactResult } from '../../../src/shared/contract/contextHealth';
import type { Message } from '../../../src/shared/contract';

function makeAppService(sessionId: string, messages: Message[], modelOverride?: string): AgentApplicationService {
  return {
    getMessages: async () => messages,
    getSessionTasks: async () => [],
    getSerializedCompressionState: () => null,
    getCurrentSessionId: () => sessionId,
    sendMessage: async () => {},
    cancel: async () => {},
    handlePermissionResponse: () => {},
    interruptAndContinue: async () => ({ outcome: 'steered' }),
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
    switchModel: async () => ({ persisted: true }),
    getModelOverride: () => modelOverride ? {
      provider: 'openai',
      model: modelOverride,
    } : undefined,
    clearModelOverride: async () => ({ persisted: true }),
    setDelegateMode: () => {},
    isDelegateMode: () => false,
    setEffortLevel: () => {},
    setThinkingEnabled: () => {},
    setInteractionMode: () => {},
    pause: () => {},
    resume: () => {},
    rewindToPrompt: async () => { throw new Error('not implemented'); },
    exportSessionDiagnostics: async () => { throw new Error('not implemented'); },
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
    compactMocks.configService.settings.contextCompression = {
      enabled: true,
      warningThreshold: 0.75,
      criticalThreshold: 0.85,
      preserveRecentCount: 10,
      triggerTokens: 100000,
      compactProvider: 'moonshot',
      compactModel: 'kimi-k2.5',
      auditEnabled: true,
    };
    compactMocks.configService.getSettings.mockClear();
    compactMocks.configService.updateSettings.mockClear();
    compactMocks.configService.getApiKey.mockClear();
    compactMocks.resetCompactModel.mockClear();
    compactMocks.getCompactModelInfo.mockClear();
    compactMocks.compactModelSummarize.mockResolvedValue('压缩摘要');
    compactMocks.compactModelSummarizeWithMetadata.mockResolvedValue({
      summary: '压缩摘要',
      metadata: {
        provider: 'moonshot',
        model: 'kimi-k2.5',
        useMainModel: false,
      },
    });
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
    expect(getSessionStateManager().getSummary(sessionId)?.contextHealth?.currentTokens).toBe(health.currentTokens);
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
              file_path: '/Users/linchen/Downloads/ai/code-agent/src/host/context/contextHealthService.ts',
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
    // commit 2ae3efa2 后 currentTokens 加上了 toolDefinitions（每次推理都发给模型的
    // tool schema 序列化），这里没传 systemPrompt 也没 tool result，所以
    // currentTokens = messages + toolDefinitions。toolDefinitions 来自 ContextHealthService
    // 自动从 tool registry 估算（小红书 session 漏算 ~14k 是修这个 bug 的初衷）。
    expect(health.currentTokens).toBe(
      health.breakdown.messages + (health.breakdown.toolDefinitions ?? 0)
    );
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
    // commit 2ae3efa2 后 currentTokens 加上了 toolDefinitions：systemPrompt + messages
    // + toolResults + toolDefinitions。这里 toolResults=0，所以 currentTokens 等于
    // systemPrompt + messages + toolDefinitions。
    expect(health.currentTokens).toBe(
      health.breakdown.systemPrompt + health.breakdown.messages + (health.breakdown.toolDefinitions ?? 0)
    );
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
    expect(compactMocks.compactModelSummarizeWithMetadata.mock.calls[0][0]).not.toContain('User Focus For This Compaction:');
  });

  it('passes optional current compact focus text through IPC into the summary prompt', async () => {
    const sessionId = 'session-compact-current-focus';
    const messages: Message[] = Array.from({ length: 14 }, (_, index) => ({
      id: `m${index + 1}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `历史消息 ${index + 1}\n${'这是一段需要被压缩的长上下文。'.repeat(260)}`,
      timestamp: index + 1,
    }));
    const appService = makeAppService(sessionId, messages, DEFAULT_MODEL);

    registerContextHealthHandlers({
      getAppService: () => appService,
      getTaskManager: () => ({
        getOrchestrator: vi.fn(() => ({ setMessages: vi.fn() })),
      }) as any,
      getSystemPromptForSession: () => '',
    });

    const handler = compactMocks.handlers.get('context:compact-current');
    expect(handler).toBeDefined();

    const result = await handler!({}, sessionId, '优先保留 /compact 命令修复线索') as CompactResult;

    expect(result.success).toBe(true);
    expect(compactMocks.compactModelSummarizeWithMetadata.mock.calls[0][0]).toContain('User Focus For This Compaction:');
    expect(compactMocks.compactModelSummarizeWithMetadata.mock.calls[0][0]).toContain('优先保留 /compact 命令修复线索');
  });

  it('exposes and persists context compression config through IPC', async () => {
    registerContextHealthHandlers({
      getAppService: () => null,
      getTaskManager: () => null,
      getSystemPromptForSession: () => '',
    });

    const getHandler = compactMocks.handlers.get('context:compression-config:get');
    const setHandler = compactMocks.handlers.get('context:compression-config:set');
    expect(getHandler).toBeDefined();
    expect(setHandler).toBeDefined();

    const initial = await getHandler!({}) as any;
    expect(initial.config.preserveRecentCount).toBe(10);
    expect(initial.features.manifest).toBe('enabled');

    const updated = await setHandler!({}, {
      enabled: false,
      preserveRecentCount: 6,
      warningThreshold: 0.8,
      compactProvider: 'openai',
      compactModel: 'gpt-5.5',
      auditEnabled: false,
    }) as any;

    expect(updated.config.enabled).toBe(false);
    expect(updated.config.preserveRecentCount).toBe(6);
    expect(updated.config.warningThreshold).toBe(0.8);
    expect(updated.config.compactProvider).toBe('openai');
    expect(updated.config.compactModel).toBe('gpt-5.5');
    expect(updated.features.audit).toBe('disabled');
    expect(compactMocks.configService.updateSettings).toHaveBeenCalledWith({
      contextCompression: expect.objectContaining({
        enabled: false,
        preserveRecentCount: 6,
        compactProvider: 'openai',
        compactModel: 'gpt-5.5',
        auditEnabled: false,
      }),
    });
  });
});
