// ============================================================================
// ContextAssembly Tests
// Verifies runtime model input honors context interventions.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { CompressionPipeline } from '../../../src/main/context/compressionPipeline';
import { CompressionState } from '../../../src/main/context/compressionState';
import { getContextInterventionState } from '../../../src/main/context/contextInterventionState';

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/main/mcp/logCollector', () => ({
  logCollector: {
    agent: vi.fn(),
    addLog: vi.fn(),
    tool: vi.fn(),
  },
}));

vi.mock('../../../src/main/prompts/builder', () => ({
  getPromptForTask: vi.fn().mockReturnValue('system prompt'),
  buildDynamicPromptV2: vi.fn(),
  buildEnhancedPrompt: vi.fn(),
}));

vi.mock('../../../src/main/agent/messageHandling/contextBuilder', () => ({
  injectWorkingDirectoryContext: vi.fn((prompt: string) => prompt),
  buildEnhancedSystemPrompt: vi.fn().mockImplementation(async (prompt: string) => prompt),
  buildRuntimeModeBlock: vi.fn().mockReturnValue(''),
}));

vi.mock('../../../src/main/lightMemory/sessionMetadata', () => ({
  buildSessionMetadataBlock: vi.fn().mockResolvedValue(''),
}));

vi.mock('../../../src/main/lightMemory/recentConversations', () => ({
  buildRecentConversationsBlock: vi.fn().mockResolvedValue(''),
}));

vi.mock('../../../src/main/lightMemory/indexLoader', () => ({
  loadMemoryIndex: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../src/main/agent/activeAgentContext', () => ({
  buildActiveAgentContext: vi.fn().mockReturnValue(''),
  drainCompletionNotifications: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/main/telemetry/systemPromptCache', () => ({
  getSystemPromptCache: () => ({
    store: vi.fn(),
  }),
}));

vi.mock('../../../src/main/services', () => ({
  getConfigService: () => ({ getApiKey: vi.fn().mockReturnValue('mock-key') }),
  getAuthService: () => ({}),
  getLangfuseService: () => ({
    startTrace: vi.fn(),
    logEvent: vi.fn(),
    endTrace: vi.fn(),
    startSpan: vi.fn().mockReturnValue('span-1'),
    endSpan: vi.fn(),
    startGenerationInSpan: vi.fn(),
  }),
  getBudgetService: () => ({
    checkBudget: vi.fn().mockReturnValue({ exceeded: false }),
    recordUsage: vi.fn(),
  }),
  BudgetAlertLevel: { NONE: 'none', WARNING: 'warning', CRITICAL: 'critical' },
  getSessionManager: () => ({
    addMessage: vi.fn(),
  }),
}));

vi.mock('../../../src/main/context/contextHealthService', () => ({
  getContextHealthService: vi.fn(),
}));

vi.mock('../../../src/main/tools/fileReadTracker', () => ({
  fileReadTracker: { getRecentFiles: vi.fn().mockReturnValue([]) },
}));

vi.mock('../../../src/main/tools/dataFingerprint', () => ({
  dataFingerprintStore: { toSummary: vi.fn().mockReturnValue('') },
}));

vi.mock('../../../src/main/context/compactModel', () => ({
  compactModelSummarize: vi.fn().mockResolvedValue('summary'),
}));

vi.mock('../../../src/shared/constants', () => ({
  DEFAULT_MODELS: {},
  MODEL_MAX_TOKENS: {},
  CONTEXT_WINDOWS: { 'test-model': 128000 },
  DEFAULT_CONTEXT_WINDOW: 128000,
  TOOL_PROGRESS: {},
  TOOL_TIMEOUT_THRESHOLDS: {},
}));

vi.mock('../../../src/main/agent/toolExecution/parallelStrategy', () => ({
  isParallelSafeTool: vi.fn(),
  classifyToolCalls: vi.fn(),
}));

vi.mock('../../../src/main/agent/toolExecution/circuitBreaker', () => ({
  CircuitBreaker: class {
    isTripped = vi.fn().mockReturnValue(false);
    recordSuccess = vi.fn();
    recordFailure = vi.fn();
  },
}));

vi.mock('../../../src/main/context/autoCompressor', () => ({
  AutoContextCompressor: class {},
  getAutoCompressor: vi.fn(),
}));

vi.mock('../../../src/main/model/modelRouter', () => ({
  ModelRouter: class {},
  ContextLengthExceededError: class extends Error {},
}));

vi.mock('../../../src/main/security/inputSanitizer', () => ({
  getInputSanitizer: vi.fn(),
}));

vi.mock('../../../src/main/services/diff/diffTracker', () => ({
  getDiffTracker: vi.fn(),
}));

vi.mock('../../../src/main/services/citation/citationService', () => ({
  getCitationService: vi.fn(),
}));

vi.mock('../../../src/main/hooks', () => ({
  HookManager: class {},
  createHookManager: vi.fn(),
}));

vi.mock('../../../src/main/agent/goalTracker', () => ({
  GoalTracker: class {},
}));

vi.mock('../../../src/main/agent/nudgeManager', () => ({
  NudgeManager: class {},
}));

vi.mock('../../../src/main/agent/antiPattern/detector', () => ({
  AntiPatternDetector: class {},
}));

vi.mock('../../../src/main/agent/sessionRecovery', () => ({
  getSessionRecoveryService: () => ({
    checkPreviousSession: vi.fn().mockResolvedValue(null),
    saveSessionState: vi.fn(),
  }),
}));

vi.mock('../../../src/main/agent/todoParser', () => ({
  parseTodos: vi.fn().mockReturnValue([]),
  mergeTodos: vi.fn().mockReturnValue([]),
  advanceTodoStatus: vi.fn().mockReturnValue({ todos: [] }),
  completeCurrentAndAdvance: vi.fn().mockReturnValue({ todos: [] }),
  getSessionTodos: vi.fn().mockReturnValue([]),
  setSessionTodos: vi.fn(),
  clearSessionTodos: vi.fn(),
}));

vi.mock('../../../src/main/services/planning/taskStore', () => ({
  getIncompleteTasks: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/main/agent/runtime/messageProcessor', () => ({
  MessageProcessor: class {},
}));

vi.mock('../../../src/main/agent/runtime/streamHandler', () => ({
  StreamHandler: class {},
}));

vi.mock('../../../src/main/agent/runtime/runFinalizer', () => ({
  RunFinalizer: class {},
}));

vi.mock('../../../src/main/agent/runtime/learningPipeline', () => ({
  LearningPipeline: class {},
}));

vi.mock('../../../src/main/agent/runtime/conversationRuntime', () => ({
  ConversationRuntime: class {},
}));

vi.mock('../../../src/main/agent/runtime/toolExecutionEngine', () => ({
  ToolExecutionEngine: class {},
}));

import { ContextAssembly } from '../../../src/main/agent/runtime/contextAssembly';

function buildMessage(id: string, role: Message['role'], content: string): Message {
  return {
    id,
    role,
    content,
    timestamp: Date.now(),
  };
}

describe('ContextAssembly.buildModelMessages()', () => {
  const sessionId = `session-${Date.now()}`;
  const agentId = 'agent-runtime-test';

  beforeEach(() => {
    getContextInterventionState().applyIntervention(sessionId, undefined, 'pinned-message', 'pin', false);
    getContextInterventionState().applyIntervention(sessionId, undefined, 'retained-message', 'retain', false);
    getContextInterventionState().applyIntervention(sessionId, undefined, 'excluded-message', 'exclude', false);
  });

  it('materializes interventions into the actual model input', async () => {
    const messages: Message[] = [
      buildMessage('pinned-message', 'user', 'pinned content'),
      buildMessage('excluded-message', 'assistant', 'excluded content'),
      buildMessage('retained-message', 'assistant', 'retained content'),
      buildMessage('base-message', 'user', 'base content'),
    ];

    const ctx = {
      systemPrompt: '',
      modelConfig: {
        provider: 'mock',
        model: 'test-model',
        apiKey: 'mock-key',
        temperature: 0,
        maxTokens: 4096,
      },
      toolRegistry: {
        getDeferredToolsSummary: vi.fn().mockReturnValue(''),
      },
      toolExecutor: {},
      messages,
      onEvent: vi.fn(),
      modelRouter: {},
      maxIterations: 1,
      workingDirectory: '/tmp',
      isDefaultWorkingDirectory: true,
      sessionId,
      agentId,
      userId: 'user-1',
      persistMessage: vi.fn(),
      onToolExecutionLog: vi.fn(),
      circuitBreaker: {},
      antiPatternDetector: {},
      goalTracker: {},
      nudgeManager: {},
      hookMessageBuffer: {
        add: vi.fn(),
        flush: vi.fn().mockReturnValue(null),
        size: 0,
      },
      messageHistoryCompressor: {
        shouldProactivelyCompress: vi.fn().mockReturnValue(false),
      },
      autoCompressor: {
        getConfig: vi.fn().mockReturnValue({ preserveRecentCount: 10 }),
      },
      compressionState: new CompressionState(),
      compressionPipeline: new CompressionPipeline(),
      telemetryAdapter: undefined,
      isCancelled: false,
      _isRunning: false,
      isInterrupted: false,
      interruptMessage: null,
      needsReinference: false,
      abortController: null,
      isPlanModeActive: false,
      planModeActive: false,
      savedMessages: null,
      currentAgentMode: 'normal',
      autoApprovePlan: false,
      enableHooks: true,
      userHooksInitialized: false,
      stopHookRetryCount: 0,
      maxStopHookRetries: 3,
      toolCallRetryCount: 0,
      maxToolCallRetries: 2,
      externalDataCallCount: 0,
      preApprovedTools: new Set<string>(),
      enableToolDeferredLoading: false,
      structuredOutputRetryCount: 0,
      maxStructuredOutputRetries: 2,
      stepByStepMode: false,
      traceId: 'trace-1',
      currentIterationSpanId: 'span-1',
      currentTurnId: 'turn-1',
      turnStartTime: Date.now(),
      toolsUsedInTurn: [],
      isSimpleTaskMode: true,
      _researchModeActive: false,
      _researchIterationCount: 0,
      researchModeInjected: false,
      budgetWarningEmitted: false,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      consecutiveErrors: 0,
      effortLevel: 'medium',
      thinkingStepCount: 0,
      runStartTime: Date.now(),
      totalIterations: 0,
      totalTokensUsed: 0,
      totalToolCallCount: 0,
      _contextOverflowRetried: false,
      _truncationRetried: false,
      _networkRetried: false,
      _consecutiveTruncations: 0,
      MAX_CONSECUTIVE_TRUNCATIONS: 3,
      contentVerificationRetries: new Map(),
      persistentSystemContext: [],
      contextHealthy: true,
      autoCompressThreshold: 0,
      contextBudgetRatio: 0,
      genNum: 8,
      initialSystemPromptLength: 0,
    };

    getContextInterventionState().applyIntervention(sessionId, agentId, 'pinned-message', 'pin', true);
    getContextInterventionState().applyIntervention(sessionId, agentId, 'retained-message', 'retain', true);
    getContextInterventionState().applyIntervention(sessionId, agentId, 'excluded-message', 'exclude', true);

    const assembly = new ContextAssembly(ctx as never);
    const modelMessages = await assembly.buildModelMessages();

    const visibleContents = modelMessages
      .slice(1)
      .map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content));

    expect(modelMessages[0].role).toBe('system');
    expect(visibleContents).toContain('pinned content');
    expect(visibleContents).toContain('retained content');
    expect(visibleContents).toContain('base content');
    expect(visibleContents).not.toContain('excluded content');
  });
});

describe('ContextAssembly.checkAndAutoCompress()', () => {
  it('records hard compaction into compressionState as autocompact', async () => {
    const sessionId = `session-autocompact-${Date.now()}`;
    const ctx: any = {
      sessionId,
      agentId: undefined,
      messages: Array.from({ length: 6 }, (_, i) => buildMessage(`m${i}`, i === 0 ? 'user' : 'assistant', `message ${i}`)),
      hookMessageBuffer: { add: vi.fn(), flush: vi.fn().mockReturnValue(''), size: 0 },
      onEvent: vi.fn(),
      modelConfig: { model: 'test-model', provider: 'test', maxTokens: 1024 },
      toolRegistry: {
        getDeferredToolsSummary: vi.fn().mockReturnValue(''),
      },
      workingDirectory: process.cwd(),
      isDefaultWorkingDirectory: true,
      persistentSystemContext: [],
      isSimpleTaskMode: false,
      compressionPipeline: new CompressionPipeline(),
      compressionState: new CompressionState(),
      autoCompressor: {
        shouldTriggerByTokens: vi.fn().mockReturnValue(true),
        compactToBlock: vi.fn().mockResolvedValue({
          block: {
            type: 'compaction',
            content: 'compressed summary',
            timestamp: Date.now(),
            compactedMessageCount: 4,
            compactedTokenCount: 123,
          },
        }),
        getConfig: vi.fn().mockReturnValue({ preserveRecentCount: 2 }),
        shouldWrapUp: vi.fn().mockReturnValue(false),
        getCompactionCount: vi.fn().mockReturnValue(1),
        getStats: vi.fn().mockReturnValue({ compressionCount: 1, totalSavedTokens: 123 }),
      },
      systemPrompt: '',
      hookManager: undefined,
    };

    const assembly = new ContextAssembly(ctx);
    await assembly.checkAndAutoCompress();

    expect(ctx.compressionState.getCommitLog()).toHaveLength(1);
    expect(ctx.compressionState.getCommitLog()[0].layer).toBe('autocompact');
    expect(ctx.compressionState.getCommitLog()[0].targetMessageIds).toHaveLength(1);
    expect(ctx.messages.some((message: Message) => message.compaction)).toBe(true);
  });
});
