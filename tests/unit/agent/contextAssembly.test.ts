// ============================================================================
// ContextAssembly Tests
// Verifies runtime model input honors context interventions.
// ============================================================================

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { CompressionPipeline } from '../../../src/main/context/compressionPipeline';
import { CompressionState } from '../../../src/main/context/compressionState';
import { getContextInterventionState } from '../../../src/main/context/contextInterventionState';
import { getContextHealthService } from '../../../src/main/context/contextHealthService';

const serviceMocks = vi.hoisted(() => ({
  sessionManager: {
    addMessage: vi.fn(),
    addMessageToSession: vi.fn(),
    replaceMessages: vi.fn(),
  },
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
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
    browser: vi.fn(),
  },
}));

vi.mock('../../../src/main/prompts/builder', () => ({
  getPromptForTask: vi.fn().mockReturnValue('system prompt'),
  buildDynamicPromptV2: vi.fn(),
  buildEnhancedPrompt: vi.fn(),
  needsGenerativeUI: vi.fn().mockReturnValue(false),
  GENERATIVE_UI_PROMPT: 'generative ui prompt',
  QUESTION_FORM_PROMPT: 'question form prompt',
  ARTIFACT_TASK_BRIEF_PROMPT: 'ARTIFACT_BRIEF_MARKER',
  needsArtifactTaskBrief: vi.fn((message: string) => /生成|create|build|write|implement/i.test(message)),
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

vi.mock('../../../src/main/lightMemory/skillLoader', () => ({
  loadRelevantSkills: vi.fn().mockResolvedValue([]),
  buildSkillInjectionBlock: vi.fn().mockReturnValue(null),
}));

vi.mock('../../../src/main/context/repoMap', () => ({
  getRepoMap: vi.fn().mockResolvedValue({
    text: '',
    fileCount: 0,
    symbolCount: 0,
    estimatedTokens: 0,
  }),
}));

vi.mock('../../../src/main/tools/dispatch/toolDefinitions', () => ({
  getDeferredToolsSummary: vi.fn().mockReturnValue(''),
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
  getSessionManager: () => serviceMocks.sessionManager,
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
  compactModelSummarizeWithMetadata: vi.fn().mockResolvedValue({
    summary: 'summary',
    metadata: {
      provider: 'mock',
      model: 'test-model',
      useMainModel: false,
    },
  }),
}));

vi.mock('../../../src/shared/constants', () => ({
  DEFAULT_PROVIDER: 'mock',
  DEFAULT_MODEL: 'test-model',
  DEFAULT_MODELS: {},
  MODEL_API_ENDPOINTS: {},
  BAIDU_OCR_ENDPOINTS: {
    token: 'https://example.invalid/oauth/token',
    accurate: 'https://example.invalid/ocr',
  },
  ZHIPU_VISION_MODEL: 'vision-model',
  getCloudApiUrl: vi.fn().mockReturnValue('https://example.invalid'),
  MODEL_MAX_TOKENS: {},
  MODEL_MAX_OUTPUT_TOKENS: {},
  CONTEXT_WINDOWS: { 'test-model': 128000 },
  MODEL_PRICING_PER_1M: {},
  MCP_TIMEOUTS: {},
  DAG_SCHEDULER: {},
  AGENT_TIMEOUTS: {},
  NETWORK_TOOL_TIMEOUTS: {},
  BROWSER_TIMEOUTS: {},
  DEFAULT_CONTEXT_WINDOW: 128000,
  getContextWindow: vi.fn().mockReturnValue(128000),
  TOOL_PROGRESS: {},
  TOOL_TIMEOUT_THRESHOLDS: {},
  // GAP-023: system prompt 预算动态化依赖
  SYSTEM_PROMPT_BUDGET: { MIN_TOKENS: 6000, WINDOW_RATIO: 0.1 },
  // tokenOptimizer 依赖（pre-existing 缺失：GAP-009 引入 TOOL_RESULT_SPILL 后 mock 未同步，导致整个 suite 加载失败）
  OBSERVATION_MASKING: {
    PRESERVE_RECENT_COUNT: 10,
    MIN_TOKEN_THRESHOLD: 100,
    PLACEHOLDER_SUCCESS: '[output cleared - tool was executed successfully]',
    PLACEHOLDER_ERROR: '[output cleared - tool returned error]',
    PLACEHOLDER_FILE_READ: '[File content omitted from history to save context.]',
  },
  TOOL_RESULT_SPILL: {
    TMP_DIR: 'tmp',
    SUBDIR: 'tool-results',
    SHARED_SESSION: 'shared',
    MAX_SPILL_BYTES: 10 * 1024 * 1024,
    NOTICE_MARKER: '[Full output saved to:',
  },
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

vi.mock('../../../src/main/agent/runtime/contextAssembly/inference', () => ({
  inference: vi.fn(),
}));

vi.mock('../../../src/main/agent/runtime/contextAssembly/modeInjection', () => ({
  loadResearchSkillPrompt: vi.fn().mockReturnValue(null),
  injectResearchModePrompt: vi.fn(),
  buildPlanContextMessage: vi.fn().mockResolvedValue(null),
  shouldThink: vi.fn().mockReturnValue(false),
  generateThinkingPrompt: vi.fn().mockReturnValue(''),
  maybeInjectThinking: vi.fn(),
}));

import { ContextAssembly, MAX_SYSTEM_PROMPT_TOKENS } from '../../../src/main/agent/runtime/contextAssembly';
import { estimateTokens } from '../../../src/main/context/tokenOptimizer';
import { buildEnhancedSystemPrompt, injectWorkingDirectoryContext } from '../../../src/main/agent/messageHandling/contextBuilder';
import { getPromptForTask } from '../../../src/main/prompts/builder';
import { needsArtifactTaskBrief, needsGenerativeUI } from '../../../src/main/prompts/builder';
import { buildSessionMetadataBlock } from '../../../src/main/lightMemory/sessionMetadata';
import { loadMemoryIndex } from '../../../src/main/lightMemory/indexLoader';
import { buildRecentConversationsBlock } from '../../../src/main/lightMemory/recentConversations';
import { loadRelevantSkills, buildSkillInjectionBlock } from '../../../src/main/lightMemory/skillLoader';
import { getRepoMap } from '../../../src/main/context/repoMap';
import { getDeferredToolsSummary } from '../../../src/main/tools/dispatch/toolDefinitions';
import {
  clearMemoryInjectionTracesForTest,
  listMemoryInjectionTraces,
} from '../../../src/main/memory/memoryInjectionTrace';

function buildMessage(id: string, role: Message['role'], content: string): Message {
  return {
    id,
    role,
    content,
    timestamp: Date.now(),
  };
}

function buildRuntimeContext(overrides: Record<string, unknown> = {}) {
  const messages = [
    buildMessage(`user-${Date.now()}-${Math.random()}`, 'user', 'fix repo code bug'),
  ];

  return {
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
    sessionId: `session-${Date.now()}-${Math.random()}`,
    agentId: undefined,
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
    compressionPipeline: {
      evaluate: vi.fn(async (transcript: unknown[], state: CompressionState) => ({
        apiView: transcript,
        totalTokens: 0,
        layersTriggered: [],
        compressionState: state,
      })),
    },
    telemetryAdapter: undefined,
    isCancelled: false,
    isInterrupted: false,
    isPaused: false,
    interruptMessage: null,
    needsReinference: false,
    abortController: null,
    runAbortController: null,
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
    traceId: 'trace-budget',
    turnTrace: { setTurn: vi.fn(), record: vi.fn(), flush: vi.fn(), getEvents: vi.fn().mockReturnValue([]) } as any,
    currentIterationSpanId: 'span-budget',
    currentTurnId: 'turn-budget',
    pendingRuntimeDiagnostics: [],
    forceFinalResponseReason: undefined,
    forceFinalResponsePrompt: undefined,
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
    _artifactNonStreamingRetried: false,
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
    ...overrides,
  };
}

afterAll(() => {
  delete process.env.CODE_AGENT_MAX_SYSTEM_PROMPT_TOKENS;
});

beforeEach(() => {
  // GAP-023: 预算已动态化（按模型窗口比例）。本文件存量测试都按固定 6000 预算设计，
  // 用 env 覆盖钉住 6000，动态化行为由专项测试单独验证（临时删掉 env）。
  process.env.CODE_AGENT_MAX_SYSTEM_PROMPT_TOKENS = '6000';
  clearMemoryInjectionTracesForTest();
  serviceMocks.sessionManager.addMessage.mockClear();
  serviceMocks.sessionManager.addMessageToSession.mockClear();
  serviceMocks.sessionManager.replaceMessages.mockClear();
  vi.mocked(getPromptForTask).mockReset();
  vi.mocked(getPromptForTask).mockReturnValue('system prompt');
  vi.mocked(needsArtifactTaskBrief).mockReset();
  vi.mocked(needsArtifactTaskBrief).mockImplementation((message: string) => /生成|create|build|write|implement/i.test(message));
  vi.mocked(needsGenerativeUI).mockReset();
  vi.mocked(needsGenerativeUI).mockReturnValue(false);
  vi.mocked(buildEnhancedSystemPrompt).mockClear();
  vi.mocked(injectWorkingDirectoryContext).mockReset();
  vi.mocked(injectWorkingDirectoryContext).mockImplementation((prompt: string) => prompt);
  vi.mocked(buildSessionMetadataBlock).mockReset();
  vi.mocked(buildSessionMetadataBlock).mockResolvedValue('');
  vi.mocked(loadMemoryIndex).mockReset();
  vi.mocked(loadMemoryIndex).mockResolvedValue(null);
  vi.mocked(loadRelevantSkills).mockReset();
  vi.mocked(loadRelevantSkills).mockResolvedValue([]);
  vi.mocked(buildSkillInjectionBlock).mockReset();
  vi.mocked(buildSkillInjectionBlock).mockReturnValue(null);
  vi.mocked(getRepoMap).mockReset();
  vi.mocked(getRepoMap).mockResolvedValue({
    text: '',
    fileCount: 0,
    symbolCount: 0,
    estimatedTokens: 0,
  });
  vi.mocked(buildRecentConversationsBlock).mockReset();
  vi.mocked(buildRecentConversationsBlock).mockResolvedValue('');
  vi.mocked(getDeferredToolsSummary).mockReset();
  vi.mocked(getDeferredToolsSummary).mockReturnValue('');
  vi.mocked(getContextHealthService).mockReset();
  vi.mocked(getContextHealthService).mockReturnValue({
    get: vi.fn().mockReturnValue({
      usagePercent: 0,
      currentTokens: 0,
      maxTokens: 128000,
    }),
    update: vi.fn().mockReturnValue({
      compression: {},
    }),
  } as never);
});

describe('ContextAssembly.buildModelMessages()', () => {
  const sessionId = `session-${Date.now()}`;
  const agentId = 'agent-runtime-test';

  beforeEach(() => {
    getContextInterventionState().applyIntervention(sessionId, undefined, 'pinned-message', 'pin', false);
    getContextInterventionState().applyIntervention(sessionId, undefined, 'retained-message', 'retain', false);
    getContextInterventionState().applyIntervention(sessionId, undefined, 'excluded-message', 'exclude', false);
  });

  it('does not inject hidden continuation proposal instructions into the model prompt', async () => {
    const ctx = buildRuntimeContext({
      sessionId: 'session-no-hidden-continuation',
      messages: [
        buildMessage('user-no-hidden-continuation', 'user', '帮我清理这些文件'),
      ],
    });

    const assembly = new ContextAssembly(ctx as never);
    const modelMessages = await assembly.buildModelMessages();
    const systemContent = String(modelMessages[0].content);

    expect(systemContent).not.toContain('handoff-proposal');
    expect(systemContent).not.toContain('worthHandoff');
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
      isInterrupted: false,
      isPaused: false,
      interruptMessage: null,
      needsReinference: false,
      abortController: null,
      runAbortController: null,
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
      turnTrace: { setTurn: vi.fn(), record: vi.fn(), flush: vi.fn(), getEvents: vi.fn().mockReturnValue([]) } as any,
      currentIterationSpanId: 'span-1',
      currentTurnId: 'turn-1',
      pendingRuntimeDiagnostics: [],
      forceFinalResponseReason: undefined,
      forceFinalResponsePrompt: undefined,
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
      _artifactNonStreamingRetried: false,
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

  it('records memory_index injection trace when memory intent matches', async () => {
    vi.mocked(loadMemoryIndex).mockResolvedValueOnce('- [Project]: Keep memory audit visible');
    const ctx = buildRuntimeContext({
      sessionId: 'session-memory-index',
      messages: [
        buildMessage('user-memory-index', 'user', '记得之前的 memory 规则吗'),
      ],
    });

    const assembly = new ContextAssembly(ctx as never);
    const modelMessages = await assembly.buildModelMessages();

    expect(modelMessages[0].content).toContain('<memory_index>');
    expect(listMemoryInjectionTraces({ sessionId: 'session-memory-index' })).toContainEqual(
      expect.objectContaining({
        blockType: 'memory_index',
        trigger: 'memory_intent',
        chars: '- [Project]: Keep memory audit visible'.length,
        injected: true,
        source: 'light-memory-index',
        count: 1,
        sessionId: 'session-memory-index',
      }),
    );
  });

  it('records memory_hint injection trace when memory intent does not match', async () => {
    const ctx = buildRuntimeContext({
      sessionId: 'session-memory-hint',
      messages: [
        buildMessage('user-memory-hint', 'user', 'fix repo code bug'),
      ],
    });

    const assembly = new ContextAssembly(ctx as never);
    const modelMessages = await assembly.buildModelMessages();

    expect(modelMessages[0].content).toContain('<memory_hint>');
    expect(listMemoryInjectionTraces({ sessionId: 'session-memory-hint' })).toEqual([
      expect.objectContaining({
        blockType: 'memory_hint',
        trigger: 'default_memory_hint',
        injected: true,
        source: 'light-memory-tool-hint',
        count: 1,
        sessionId: 'session-memory-hint',
      }),
    ]);
  });

  it('records recent_conversations injection trace when recent intent matches', async () => {
    vi.mocked(buildRecentConversationsBlock).mockResolvedValueOnce('- Previous task: memory audit');
    const ctx = buildRuntimeContext({
      sessionId: 'session-recent-conversations',
      messages: [
        buildMessage('user-recent-conversations', 'user', 'continue recent context'),
      ],
    });

    const assembly = new ContextAssembly(ctx as never);
    const modelMessages = await assembly.buildModelMessages();

    expect(modelMessages[0].content).toContain('- Previous task: memory audit');
    expect(listMemoryInjectionTraces({ sessionId: 'session-recent-conversations' })).toContainEqual(
      expect.objectContaining({
        blockType: 'recent_conversations',
        trigger: 'recent_conversations_intent',
        chars: '- Previous task: memory audit'.length,
        injected: true,
        source: 'recent-conversations',
        count: 1,
        sessionId: 'session-recent-conversations',
      }),
    );
  });

  it('does not append runtime-only prompt blocks past the system prompt budget', async () => {
    vi.mocked(getPromptForTask).mockReturnValueOnce('base '.repeat(5900));

    const ctx = buildRuntimeContext({
      persistentSystemContext: [
        `PERSISTENT_MARKER ${'extra '.repeat(400)}`,
      ],
    });

    const assembly = new ContextAssembly(ctx as never);
    const modelMessages = await assembly.buildModelMessages();

    expect(modelMessages[0].role).toBe('system');
    expect(modelMessages[0].content).not.toContain('PERSISTENT_MARKER');
  });

  it('prioritizes capability discovery blocks over nice-to-have blocks under budget pressure (GAP-023)', async () => {
    // base prompt 占掉大部分预算，session metadata（锦上添花）很大、deferred tools（能力发现）很小：
    // 重排后 deferred tools 先追加（能装下），session metadata 后追加（超预算被丢弃）。
    // 重排前的旧行为是反过来的——session metadata 先到先得，deferred tools 被静默丢弃。
    vi.mocked(getPromptForTask).mockReturnValueOnce('base '.repeat(4000));
    vi.mocked(buildSessionMetadataBlock).mockResolvedValueOnce(
      `<session_metadata>${'session '.repeat(3000)}</session_metadata>`,
    );
    vi.mocked(getDeferredToolsSummary).mockReturnValueOnce('browser: 浏览器操作工具组');

    const ctx = buildRuntimeContext({
      enableToolDeferredLoading: true,
      messages: [buildMessage('user-gap023', 'user', '帮我查一下这个仓库的代码结构')],
    });

    const assembly = new ContextAssembly(ctx as never);
    const modelMessages = await assembly.buildModelMessages();

    const systemPrompt = modelMessages[0].content;
    // 能力发现块保住了
    expect(systemPrompt).toContain('<deferred-tools>');
    expect(systemPrompt).toContain('browser: 浏览器操作工具组');
    // 锦上添花块被丢弃
    expect(systemPrompt).not.toContain('<session_metadata>');
    expect(estimateTokens(systemPrompt)).toBeLessThanOrEqual(MAX_SYSTEM_PROMPT_TOKENS);
    // GAP-023 丢弃可见化：被丢弃的块记录到 runtime ctx（流向 context health 面板）
    const droppedBlocks = (ctx as { droppedPromptBlocks?: string[] }).droppedPromptBlocks ?? [];
    expect(droppedBlocks).toContain('session metadata');
    expect(droppedBlocks).not.toContain('deferred tools');
  });

  it('expands the budget by model context window when no env override is set (GAP-023 dynamization)', async () => {
    // 删掉 env 覆盖 → 预算按 getContextWindow('test-model')=128000 * 0.1 = 12800
    delete process.env.CODE_AGENT_MAX_SYSTEM_PROMPT_TOKENS;
    try {
      // base 5000 + deferred tools ~2000：固定 6000 预算下会被丢弃，动态 12800 预算下应该保留
      vi.mocked(getPromptForTask).mockReturnValueOnce('base '.repeat(5000));
      vi.mocked(getDeferredToolsSummary).mockReturnValueOnce('tools '.repeat(2000));

      const ctx = buildRuntimeContext({
        enableToolDeferredLoading: true,
        messages: [buildMessage('user-gap023-dyn', 'user', '帮我查一下今天的天气')],
      });

      const assembly = new ContextAssembly(ctx as never);
      const modelMessages = await assembly.buildModelMessages();

      expect(modelMessages[0].content).toContain('<deferred-tools>');
      const droppedBlocks = (ctx as { droppedPromptBlocks?: string[] }).droppedPromptBlocks ?? [];
      expect(droppedBlocks).not.toContain('deferred tools');
    } finally {
      process.env.CODE_AGENT_MAX_SYSTEM_PROMPT_TOKENS = '6000';
    }
  });

  it('places capability discovery blocks before nice-to-have blocks in the prompt (GAP-023)', async () => {
    // 预算充足时全部块都注入，但顺序必须是能力发现块在前
    vi.mocked(getDeferredToolsSummary).mockReturnValueOnce('browser: deferred tools entry');
    vi.mocked(buildSessionMetadataBlock).mockResolvedValueOnce('<session_metadata>light usage</session_metadata>');

    const ctx = buildRuntimeContext({
      enableToolDeferredLoading: true,
      messages: [buildMessage('user-gap023-order', 'user', '帮我查一下今天的天气')],
    });

    const assembly = new ContextAssembly(ctx as never);
    const modelMessages = await assembly.buildModelMessages();

    const systemPrompt = modelMessages[0].content;
    const deferredToolsIndex = systemPrompt.indexOf('<deferred-tools>');
    const sessionMetadataIndex = systemPrompt.indexOf('<session_metadata>');
    const memoryHintIndex = systemPrompt.indexOf('<memory_hint>');

    expect(deferredToolsIndex).toBeGreaterThan(-1);
    expect(sessionMetadataIndex).toBeGreaterThan(-1);
    expect(memoryHintIndex).toBeGreaterThan(-1);
    // 能力发现块（deferred tools）在锦上添花块（session metadata / memory hint）之前
    expect(deferredToolsIndex).toBeLessThan(sessionMetadataIndex);
    expect(deferredToolsIndex).toBeLessThan(memoryHintIndex);
  });

  it('injects compact game contract and skips optional prompt blocks for game artifact generation tasks', async () => {
    vi.mocked(getPromptForTask).mockReturnValueOnce('base '.repeat(4800));
    vi.mocked(needsGenerativeUI).mockReturnValueOnce(true);
    vi.mocked(buildSessionMetadataBlock).mockResolvedValueOnce(`<session_metadata>${'session '.repeat(300)}</session_metadata>`);
    vi.mocked(loadMemoryIndex).mockResolvedValueOnce(`<memory_index>${'memory '.repeat(300)}</memory_index>`);
    vi.mocked(loadRelevantSkills).mockResolvedValueOnce([
      {
        filename: 'skill_big.md',
        name: 'big-skill',
        description: 'large irrelevant skill',
        body: 'skill body',
        matchScore: 1,
      },
    ]);
    vi.mocked(buildSkillInjectionBlock).mockReturnValueOnce(`<relevant_skills>${'skill '.repeat(900)}</relevant_skills>`);
    vi.mocked(buildRecentConversationsBlock).mockResolvedValueOnce(`<recent_conversations>${'recent '.repeat(300)}</recent_conversations>`);
    vi.mocked(getDeferredToolsSummary).mockReturnValueOnce('deferred '.repeat(300));

    const ctx = buildRuntimeContext({
      isSimpleTaskMode: false,
      enableToolDeferredLoading: true,
      workingDirectory: '/tmp/code-agent',
      isDefaultWorkingDirectory: false,
      messages: [
        buildMessage('user-artifact', 'user', '继续生成一个类似超级玛丽的单文件 HTML 游戏，记得 previous context，保存到 /tmp/game.html'),
      ],
    });

    const assembly = new ContextAssembly(ctx as never);
    const modelMessages = await assembly.buildModelMessages();

    expect(modelMessages[0].role).toBe('system');
    expect(modelMessages[0].content).toContain('## Game Artifact Contract');
    expect(modelMessages[0].content).toContain('window.__GAME_META__');
    expect(modelMessages[0].content).toContain('validator-readable authored unit field');
    expect(modelMessages[0].content).toContain('levels');
    expect(modelMessages[0].content).toContain('segments');
    expect(modelMessages[0].content).toContain('scenarios');
    expect(modelMessages[0].content).toContain('qualityPlan');
    expect(modelMessages[0].content).toContain('acceptance');
    expect(modelMessages[0].content).toContain('progressPlan');
    expect(modelMessages[0].content).toContain('generic `progress`');
    expect(modelMessages[0].content).toContain('Reachability steps must be short');
    expect(modelMessages[0].content).toContain('Platformers must include acceleration/friction');
    expect(modelMessages[0].content).toContain('Gameplay Mechanics Contract');
    expect(modelMessages[0].content).toContain('gameplayMechanics');
    expect(modelMessages[0].content).toContain('stompable enemy');
    expect(modelMessages[0].content).toContain('bumpable/question block');
    expect(modelMessages[0].content).toContain('comboChallenge');
    expect(modelMessages[0].content).toContain('browserVisualSmoke');
    expect(modelMessages[0].content).toContain('start()');
    expect(modelMessages[0].content).toContain('reset(levelOrScenario?)');
    expect(modelMessages[0].content).toContain('snapshot()');
    expect(modelMessages[0].content).toContain('step(inputState, frames?)');
    expect(modelMessages[0].content).toContain('runSmokeTest()');
    expect(modelMessages[0].content).toContain('input-driven');
    expect(modelMessages[0].content).not.toContain('ARTIFACT_BRIEF_MARKER');
    expect(modelMessages[0].content).not.toContain('<session_metadata>');
    expect(modelMessages[0].content).not.toContain('<memory_index>');
    expect(modelMessages[0].content).not.toContain('<memory_hint>');
    expect(modelMessages[0].content).not.toContain('<relevant_skills>');
    expect(modelMessages[0].content).not.toContain('<repo_map>');
    expect(modelMessages[0].content).not.toContain('<recent_conversations>');
    expect(modelMessages[0].content).not.toContain('generative ui prompt');
    expect(modelMessages[0].content).not.toContain('question form prompt');
    expect(modelMessages[0].content).not.toContain('<deferred-tools>');
    expect(estimateTokens(modelMessages[0].content)).toBeLessThanOrEqual(MAX_SYSTEM_PROMPT_TOKENS);
    expect(buildSessionMetadataBlock).not.toHaveBeenCalled();
    expect(loadMemoryIndex).not.toHaveBeenCalled();
    expect(getRepoMap).not.toHaveBeenCalled();
    expect(buildRecentConversationsBlock).not.toHaveBeenCalled();
    expect(getDeferredToolsSummary).not.toHaveBeenCalled();
  });

  it('keeps compact game contract when later environment context is added', async () => {
    vi.mocked(getPromptForTask).mockReturnValueOnce('base '.repeat(4800));
    vi.mocked(injectWorkingDirectoryContext).mockImplementationOnce((prompt: string) => `${prompt}\n\nENV_MARKER ${'env '.repeat(120)}`);

    const ctx = buildRuntimeContext({
      isSimpleTaskMode: false,
      workingDirectory: '/tmp/code-agent',
      isDefaultWorkingDirectory: false,
      messages: [
        buildMessage('user-artifact-env', 'user', '生成一个可玩的单文件 HTML 游戏，保存到 /tmp/game.html'),
      ],
    });

    const assembly = new ContextAssembly(ctx as never);
    const modelMessages = await assembly.buildModelMessages();

    expect(modelMessages[0].role).toBe('system');
    expect(modelMessages[0].content).toContain('## Game Artifact Contract');
    expect(modelMessages[0].content).toContain('window.__GAME_META__');
    expect(modelMessages[0].content).toContain('start()');
    expect(modelMessages[0].content).toContain('ENV_MARKER');
    expect(ctx.pendingRuntimeDiagnostics).not.toContain(expect.stringContaining('跳过 artifact task brief'));
    expect(ctx.pendingRuntimeDiagnostics).not.toContain(expect.stringContaining('保留必需 game artifact contract'));
    expect(estimateTokens(modelMessages[0].content)).toBeLessThanOrEqual(MAX_SYSTEM_PROMPT_TOKENS);
  });

  it('prioritizes artifact repair context over optional prompt blocks', async () => {
    vi.mocked(getPromptForTask).mockReturnValueOnce('base '.repeat(5400));
    vi.mocked(needsArtifactTaskBrief).mockReturnValue(false);
    vi.mocked(buildSessionMetadataBlock).mockResolvedValueOnce(`<session_metadata>${'session '.repeat(220)}</session_metadata>`);
    vi.mocked(loadMemoryIndex).mockResolvedValueOnce(`<memory_index>${'memory '.repeat(220)}</memory_index>`);
    vi.mocked(loadRelevantSkills).mockResolvedValueOnce([
      {
        filename: 'game_skill.md',
        name: 'game artifact skill',
        description: 'large artifact skill',
        body: 'skill body',
        matchScore: 1,
      },
    ]);
    vi.mocked(buildSkillInjectionBlock).mockReturnValueOnce(`<relevant_skills>${'skill '.repeat(220)}</relevant_skills>`);
    vi.mocked(getRepoMap).mockResolvedValueOnce({
      text: 'repo '.repeat(220),
      fileCount: 9,
      symbolCount: 9,
      estimatedTokens: 220,
    });
    vi.mocked(buildRecentConversationsBlock).mockResolvedValueOnce(`<recent_conversations>${'recent '.repeat(220)}</recent_conversations>`);
    vi.mocked(getDeferredToolsSummary).mockReturnValueOnce('deferred '.repeat(220));

    const ctx = buildRuntimeContext({
      isSimpleTaskMode: false,
      enableToolDeferredLoading: true,
      workingDirectory: '/tmp/code-agent',
      isDefaultWorkingDirectory: false,
      messages: [
        buildMessage('user-repair', 'user', '继续修复这个 repo code，记得 previous context'),
      ],
      persistentSystemContext: [
        [
          '<artifact-validation-failed kind="interactive_artifact">',
          'Artifact validation failed for /tmp/game.html.',
          '1. 缺少真实可点击开始按钮。',
          '请直接修正现有文件，再继续验证。',
          '</artifact-validation-failed>',
        ].join('\n'),
      ],
    });

    const assembly = new ContextAssembly(ctx as never);
    const modelMessages = await assembly.buildModelMessages();
    const systemPrompt = modelMessages[0].content;

    expect(modelMessages[0].role).toBe('system');
    expect(systemPrompt).toContain('## Game Artifact Repair Contract');
    expect(systemPrompt).toContain('window.__GAME_META__');
    expect(systemPrompt).toContain('start()');
    expect(systemPrompt).toContain('<artifact-validation-failed kind="interactive_artifact">');
    expect(systemPrompt).toContain('缺少真实可点击开始按钮');
    expect(systemPrompt).not.toContain('<session_metadata>');
    expect(systemPrompt).not.toContain('<memory_index>');
    expect(systemPrompt).not.toContain('<memory_hint>');
    expect(systemPrompt).not.toContain('<relevant_skills>');
    expect(systemPrompt).not.toContain('<repo_map>');
    expect(systemPrompt).not.toContain('<recent_conversations>');
    expect(systemPrompt).not.toContain('<deferred-tools>');
    expect(buildSessionMetadataBlock).not.toHaveBeenCalled();
    expect(loadMemoryIndex).not.toHaveBeenCalled();
    expect(loadRelevantSkills).not.toHaveBeenCalled();
    expect(getRepoMap).not.toHaveBeenCalled();
    expect(buildRecentConversationsBlock).not.toHaveBeenCalled();
    expect(getDeferredToolsSummary).not.toHaveBeenCalled();
  });

  it('keeps non-game artifact repair on the generic artifact brief', async () => {
    const ctx = buildRuntimeContext({
      messages: [
        buildMessage('user-dashboard-repair', 'user', '修复 /tmp/dashboard.html 这个交互页面'),
      ],
      persistentSystemContext: [
        [
          '<artifact-validation-failed kind="interactive_artifact">',
          'Artifact validation failed for /tmp/dashboard.html.',
          '1. 缺少真实可点击开始按钮。',
          '</artifact-validation-failed>',
        ].join('\n'),
      ],
    });

    const assembly = new ContextAssembly(ctx as never);
    const modelMessages = await assembly.buildModelMessages();
    const systemPrompt = modelMessages[0].content;

    expect(systemPrompt).toContain('ARTIFACT_BRIEF_MARKER');
    expect(systemPrompt).not.toContain('## Game Artifact Contract');
    expect(systemPrompt).toContain('<artifact-repair-focus>');
  });

  it('adds focused repair instructions when artifact validation names a target and failures', async () => {
    const targetFile = '/tmp/game.html';
    const ctx = buildRuntimeContext({
      messages: [
        buildMessage('user-repair-focus', 'user', `修复 ${targetFile}`),
        {
          id: 'tool-repair-focus',
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolResults: [
            {
              toolCallId: 'tc-edit-failed',
              success: false,
              error: 'Artifact validation failed for /tmp/game.html.',
              metadata: {
                artifactValidation: {
                  failed: true,
                  attempts: 2,
                  phase: 'targeted_repair',
                  failures: [
                    'runSmokeTest records enemy_present instead of input-driven before/after state changes.',
                  ],
                  repairSpec: {
                    issues: [{ code: 'coverage_without_runtime_evidence' }],
                  },
                },
              },
            },
          ],
        } as Message,
      ],
      artifactRepairGuard: {
        targetFile,
        attempts: 2,
        phase: 'targeted_repair',
        activeIssueCodes: [
          'coverage_without_runtime_evidence',
          'missing_contract_start',
          'missing_coverage_metadata',
          'smoke_missing_coverage',
          'control_no_state_change',
        ],
        patched: false,
      },
      persistentSystemContext: [
        [
          '<artifact-validation-failed kind="interactive_artifact">',
          'attempts: 2',
          'repair phase: targeted_repair',
          `target file: ${targetFile}`,
          '1. runSmokeTest records enemy_present instead of input-driven before/after state changes.',
          '</artifact-validation-failed>',
        ].join('\n'),
      ],
    });

    const assembly = new ContextAssembly(ctx as never);
    const modelMessages = await assembly.buildModelMessages();
    const systemPrompt = modelMessages[0].content;

    expect(systemPrompt).toContain('<artifact-repair-focus>');
    expect(systemPrompt).toContain(`Target file: ${targetFile}`);
    expect(systemPrompt).toContain('Repair phase: targeted_repair');
    expect(systemPrompt).toContain('Validation failures to fix now:');
    expect(systemPrompt).toContain('runSmokeTest records enemy_present instead of input-driven before/after state changes.');
    expect(systemPrompt).toContain('Active issue codes: coverage_without_runtime_evidence');
    expect(systemPrompt).toContain('Direct repair requirements:');
    expect(systemPrompt).toContain('missing_contract_start: add a real `start()` method');
    expect(systemPrompt).toContain('missing_coverage_metadata: add literal `window.__GAME_META__`');
    expect(systemPrompt).toContain('validator-readable authored units');
    expect(systemPrompt).toContain('`levels`, `segments`, `scenarios`');
    expect(systemPrompt).toContain('smoke_missing_coverage: make `runSmokeTest()` return structured input-driven coverage');
    expect(systemPrompt).toContain('reachability_evidence: every `progressPlan` / `reachability` step');
    expect(systemPrompt).toContain('Edit, Append, or Write the target file now');
    expect(systemPrompt).toContain('Do not use Grep, Glob, Task, ToolSearch');
    expect(systemPrompt).toContain(`Repair ${targetFile} directly`);
    expect(systemPrompt).toContain('Keep the interactive contract tied to live gameplay state');
  });

  it('keeps the full target file read history during artifact repair mode (Route A — no compression)', async () => {
    const largeHtml = [
      '<!doctype html>',
      '<html>',
      '<body>',
      '<script>',
      'const filler = `' + 'x'.repeat(14000) + '`;',
      'window.__GAME_TEST__ = { runSmokeTest() { return { passed: false }; } };',
      '</script>',
      '</body>',
      '</html>',
    ].join('\n');

    const targetFile = '/tmp/game.html';
    const ctx = buildRuntimeContext({
      messages: [
        buildMessage('user-repair-large', 'user', `修复 ${targetFile}`),
        {
          id: 'tool-message-large',
          role: 'tool',
          content: JSON.stringify([
            {
              toolCallId: 'read-target',
              success: true,
              output: largeHtml,
              metadata: {
                preserveObservation: true,
                evidenceKind: 'file_read',
                filePath: targetFile,
              },
            },
          ]),
          timestamp: Date.now(),
          toolResults: [
            {
              toolCallId: 'read-target',
              success: true,
              output: largeHtml,
              metadata: {
                preserveObservation: true,
                evidenceKind: 'file_read',
                filePath: targetFile,
              },
            },
          ],
        } as Message,
      ],
      artifactRepairGuard: {
        targetFile,
        attempts: 2,
        phase: 'targeted_repair',
      },
      persistentSystemContext: [
        '<artifact-validation-failed kind="interactive_artifact">\nArtifact validation failed for /tmp/game.html.\n</artifact-validation-failed>',
      ],
    });

    const assembly = new ContextAssembly(ctx as never);
    const modelMessages = await assembly.buildModelMessages();
    const toolMessage = modelMessages.find((message) => message.role === 'tool');

    // Route A: the artifact under repair is never compressed — the model gets the full file.
    expect(toolMessage?.content).toContain(largeHtml);
    expect(toolMessage?.content).not.toContain('<artifact-repair-file-read>');
    expect(toolMessage?.content).not.toContain('History preview compressed');
  });

  it('filters stale assistant tool history to the current artifact-repair allowlist', async () => {
    const ctx = buildRuntimeContext({
      messages: [
        {
          id: 'assistant-tool-history',
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          toolCalls: [
            { id: 'tc-read', name: 'Read', arguments: { file_path: '/tmp/game.html' } },
            { id: 'tc-edit', name: 'Edit', arguments: { file_path: '/tmp/game.html', edits: [] } },
            { id: 'tc-bash', name: 'Bash', arguments: { command: 'npm test' } },
          ],
        } as Message,
      ],
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 1,
        phase: 'baseline_repair',
        patched: false,
      },
      persistentSystemContext: [
        '<artifact-validation-failed kind="interactive_artifact">\nArtifact validation failed for /tmp/game.html.\n</artifact-validation-failed>',
      ],
    });

    const assembly = new ContextAssembly(ctx as never);
    const modelMessages = await assembly.buildModelMessages();
    const assistantMessage = modelMessages.find((message) => message.role === 'assistant');
    // Route A: pre-patch allowlist is Read/Edit/Write/Append — stale Bash is dropped, Read stays.
    expect(assistantMessage?.toolCalls?.map((toolCall: any) => toolCall.name)).toEqual(['Read', 'Edit']);
  });

  it('filters stale tool results to match the current artifact-repair allowlist', async () => {
    const ctx = buildRuntimeContext({
      messages: [
        {
          id: 'assistant-tool-history',
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          toolCalls: [
            { id: 'tc-read', name: 'Read', arguments: { file_path: '/tmp/game.html' } },
            { id: 'tc-write', name: 'Write', arguments: { file_path: '/tmp/game.html', content: '<html></html>' } },
          ],
        } as Message,
        {
          id: 'tool-history',
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolResults: [
            {
              toolCallId: 'tc-read',
              success: true,
              output: 'old read result should be filtered',
              metadata: { evidenceKind: 'file_read', filePath: '/tmp/validator.ts' },
            },
            {
              toolCallId: 'tc-write',
              success: false,
              error: 'Artifact validation failed for /tmp/game.html.',
            },
          ],
        } as Message,
      ],
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 1,
        phase: 'baseline_repair',
        patched: false,
      },
      persistentSystemContext: [
        '<artifact-validation-failed kind="interactive_artifact">\nArtifact validation failed for /tmp/game.html.\n</artifact-validation-failed>',
      ],
    });

    const assembly = new ContextAssembly(ctx as never);
    const modelMessages = await assembly.buildModelMessages();
    const assistantMessage = modelMessages.find((message) => message.role === 'assistant');
    const toolMessages = modelMessages.filter((message) => message.role === 'tool');

    // Route A: pre-patch allowlist keeps Read + mutation tool calls; the failed
    // validation result stays in history so the model sees what it must fix.
    expect(assistantMessage?.toolCalls?.map((toolCall: any) => toolCall.name)).toEqual(['Read', 'Write']);
    expect(toolMessages.some((message) => JSON.stringify(message.content).includes('Artifact validation failed'))).toBe(true);
  });

  it('compresses failed artifact validation history instead of replaying the full repair spec', async () => {
    const ctx = buildRuntimeContext({
      messages: [
        {
          id: 'assistant-failed-repair',
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          toolCalls: [
            {
              id: 'tc-edit-failed',
              name: 'Edit',
              arguments: {
                file_path: '/tmp/game.html',
                edits: [{ old_text: 'start() {', new_text: 'start() { State.mode = "playing";' }],
              },
            },
          ],
        } as Message,
        {
          id: 'tool-failed-repair',
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolResults: [
            {
              toolCallId: 'tc-edit-failed',
              success: false,
              error: [
                'Artifact validation failed for /tmp/game.html.',
                '<artifact_repair_spec>',
                JSON.stringify({
                  kind: 'game_artifact_repair',
                  issues: [{ code: 'coverage_without_runtime_evidence' }],
                  repairHints: ['x'.repeat(5000)],
                }),
                '</artifact_repair_spec>',
                'The failed artifact repair patch was rolled back.',
              ].join('\n'),
              metadata: {
                artifactRepairRollback: {
                  attempted: true,
                  applied: true,
                  targetFile: '/tmp/game.html',
                },
                artifactValidation: {
                  failed: true,
                  attempts: 1,
                  phase: 'baseline_repair',
                  inferredKind: 'game',
                  failures: [
                    'runSmokeTest 把对象存在、机制注册或覆盖声明当成通过证据。',
                  ],
                  repairSpec: {
                    kind: 'game_artifact_repair',
                    issues: [{ code: 'coverage_without_runtime_evidence' }],
                  },
                },
              },
            },
          ],
        } as Message,
      ],
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 1,
        phase: 'baseline_repair',
        patched: false,
      },
      persistentSystemContext: [
        '<artifact-validation-failed kind="interactive_artifact">\nArtifact validation failed for /tmp/game.html.\n</artifact-validation-failed>',
      ],
    });

    const assembly = new ContextAssembly(ctx as never);
    const modelMessages = await assembly.buildModelMessages();
    const toolMessage = modelMessages.find((message) => message.role === 'tool');

    expect(toolMessage?.content).toContain('<artifact-validation-failed-history>');
    expect(toolMessage?.content).toContain('coverage_without_runtime_evidence');
    expect(toolMessage?.content).toContain('The failed patch was rolled back');
    expect(toolMessage?.content).not.toContain('<artifact_repair_spec>');
    expect(toolMessage?.content).not.toContain('x'.repeat(1000));
  });

  it('preserves small exact ranged target-file reads before write-priority artifact repair', async () => {
    const exactContract = [
      'window.__GAME_TEST__ = {',
      '  runSmokeTest() {',
      '    const before = this.snapshot();',
      '    const after = this.step({ ArrowRight: true }, 80);',
      "    if (after.playerX > before.playerX) coverage.mechanics.push('movement');",
      '  }',
      '};',
      'FILLER '.repeat(200),
    ].join('\n');
    const ctx = buildRuntimeContext({
      messages: [
        buildMessage('user-repair-ranged-read', 'user', 'fix the game contract'),
        {
          id: 'assistant-read-range',
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          toolCalls: [
            {
              id: 'tc-read-range',
              name: 'Read',
              arguments: { file_path: '/tmp/game.html', offset: 1086, limit: 200 },
            },
          ],
        } as Message,
        {
          id: 'tool-read-range',
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolResults: [
            {
              toolCallId: 'tc-read-range',
              success: true,
              output: exactContract,
              metadata: {
                preserveObservation: true,
                evidenceKind: 'file_read',
                filePath: '/tmp/game.html',
                rangedRead: true,
              },
            },
          ],
        } as Message,
      ],
      artifactRepairGuard: {
        targetFile: '/tmp/game.html',
        attempts: 1,
        phase: 'baseline_repair',
        activeIssueCodes: ['coverage_without_runtime_evidence'],
        patched: false,
      },
      persistentSystemContext: [
        '<artifact-validation-failed kind="interactive_artifact">\ncoverage_without_runtime_evidence\n</artifact-validation-failed>',
      ],
    });

    const assembly = new ContextAssembly(ctx as never);
    const modelMessages = await assembly.buildModelMessages();
    const toolMessage = modelMessages.find((message) => message.role === 'tool');

    expect(toolMessage?.content).toContain('window.__GAME_TEST__ = {');
    expect(toolMessage?.content).toContain("coverage.mechanics.push('movement')");
    expect(toolMessage?.content).not.toContain('<artifact-repair-file-read>');
    expect(toolMessage?.content).not.toContain('History preview compressed for repair mode');
  });

  it('keeps normal code task prompt block injection unchanged', async () => {
    vi.mocked(needsArtifactTaskBrief).mockReturnValue(false);
    vi.mocked(buildSessionMetadataBlock).mockResolvedValueOnce('<session_metadata>normal</session_metadata>');
    vi.mocked(loadMemoryIndex).mockResolvedValueOnce('<memory_index>normal memory</memory_index>');
    vi.mocked(loadRelevantSkills).mockResolvedValueOnce([
      {
        filename: 'perf.md',
        name: 'perf',
        description: 'performance skill',
        body: 'measure performance',
        matchScore: 1,
      },
    ]);
    vi.mocked(buildSkillInjectionBlock).mockReturnValueOnce('<relevant_skills>perf</relevant_skills>');
    vi.mocked(getRepoMap).mockResolvedValueOnce({
      text: 'repo map normal',
      fileCount: 1,
      symbolCount: 1,
      estimatedTokens: 20,
    });
    vi.mocked(buildRecentConversationsBlock).mockResolvedValueOnce('<recent_conversations>normal</recent_conversations>');
    vi.mocked(getDeferredToolsSummary).mockReturnValueOnce('browser: deferred');

    const ctx = buildRuntimeContext({
      isSimpleTaskMode: false,
      enableToolDeferredLoading: true,
      workingDirectory: '/tmp/code-agent',
      isDefaultWorkingDirectory: false,
      messages: [
        buildMessage('user-normal-context', 'user', '继续修复 repo code bug，记得 previous context'),
      ],
    });

    const assembly = new ContextAssembly(ctx as never);
    const modelMessages = await assembly.buildModelMessages();
    const systemPrompt = modelMessages[0].content;

    expect(systemPrompt).toContain('<session_metadata>normal</session_metadata>');
    expect(systemPrompt).toContain('<memory_index>normal memory</memory_index>');
    expect(systemPrompt).toContain('<relevant_skills>perf</relevant_skills>');
    expect(systemPrompt).toContain('<repo_map>');
    expect(systemPrompt).toContain('repo map normal');
    expect(systemPrompt).toContain('<recent_conversations>normal</recent_conversations>');
    expect(systemPrompt).toContain('<deferred-tools>');
    expect(systemPrompt).toContain('browser: deferred');
  });

  it('reuses heavy prompt blocks within a user turn and invalidates compression on transcript change', async () => {
    const runtimeSessionId = `session-cache-${Date.now()}`;
    const messages: Message[] = [
      buildMessage('user-1', 'user', '继续优化 repo code performance，记得看 previous context'),
    ];
    const evaluate = vi.fn(async (transcript: unknown[], state: CompressionState) => ({
      apiView: transcript,
      totalTokens: 100,
      layersTriggered: [],
      compressionState: state,
    }));
    const restoredCompressionState = new CompressionState();
    restoredCompressionState.applyCommit({
      layer: 'autocompact',
      operation: 'collapse',
      targetMessageIds: ['restored-message'],
      timestamp: 123,
      metadata: { summary: 'restored compacted context' },
    });

    vi.mocked(buildEnhancedSystemPrompt).mockClear();
    vi.mocked(loadMemoryIndex).mockClear();
    vi.mocked(loadRelevantSkills).mockClear();
    vi.mocked(getRepoMap).mockClear();
    vi.mocked(buildRecentConversationsBlock).mockClear();
    vi.mocked(loadMemoryIndex).mockResolvedValue('memory index');
    vi.mocked(loadRelevantSkills).mockResolvedValue([
      {
        filename: 'skill_perf.md',
        name: 'perf',
        description: 'performance work',
        body: 'measure then cache',
        matchScore: 1,
      },
    ]);
    vi.mocked(buildSkillInjectionBlock).mockReturnValue('<relevant_skills>perf</relevant_skills>');
    vi.mocked(getRepoMap).mockResolvedValue({
      text: 'repo map',
      fileCount: 1,
      symbolCount: 1,
      estimatedTokens: 20,
    });
    vi.mocked(buildRecentConversationsBlock).mockResolvedValue('<recent_conversations>recent</recent_conversations>');
    vi.mocked(needsArtifactTaskBrief).mockReturnValue(false);

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
      workingDirectory: '/tmp/code-agent',
      isDefaultWorkingDirectory: false,
      sessionId: runtimeSessionId,
      agentId: undefined,
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
      compressionState: restoredCompressionState,
      compressionPipeline: { evaluate },
      telemetryAdapter: undefined,
      isCancelled: false,
      isInterrupted: false,
      isPaused: false,
      interruptMessage: null,
      needsReinference: false,
      abortController: null,
      runAbortController: null,
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
      traceId: 'trace-cache',
      turnTrace: { setTurn: vi.fn(), record: vi.fn(), flush: vi.fn(), getEvents: vi.fn().mockReturnValue([]) } as any,
      currentIterationSpanId: 'span-cache',
      currentTurnId: 'turn-cache',
      pendingRuntimeDiagnostics: [],
      forceFinalResponseReason: undefined,
      forceFinalResponsePrompt: undefined,
      turnStartTime: Date.now(),
      toolsUsedInTurn: [],
      isSimpleTaskMode: false,
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
      _artifactNonStreamingRetried: false,
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

    const assembly = new ContextAssembly(ctx as never);
    await assembly.buildModelMessages();

    expect((evaluate.mock.calls[0][1] as CompressionState).getCommitLog()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          layer: 'autocompact',
          operation: 'collapse',
          targetMessageIds: ['restored-message'],
        }),
      ]),
    );
    expect(ctx.compressionState.getCommitLog()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          layer: 'autocompact',
          operation: 'collapse',
          targetMessageIds: ['restored-message'],
        }),
      ]),
    );

    await assembly.buildModelMessages();

    expect(buildEnhancedSystemPrompt).toHaveBeenCalledTimes(1);
    expect(loadMemoryIndex).toHaveBeenCalledTimes(1);
    expect(loadRelevantSkills).toHaveBeenCalledTimes(1);
    expect(getRepoMap).toHaveBeenCalledTimes(1);
    expect(buildRecentConversationsBlock).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(1);

    messages.push(buildMessage('tool-1', 'tool', 'tool result changed transcript'));
    await assembly.buildModelMessages();

    expect(buildEnhancedSystemPrompt).toHaveBeenCalledTimes(1);
    expect(loadMemoryIndex).toHaveBeenCalledTimes(1);
    expect(loadRelevantSkills).toHaveBeenCalledTimes(1);
    expect(getRepoMap).toHaveBeenCalledTimes(1);
    expect(buildRecentConversationsBlock).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });
});

describe('ContextAssembly.checkAndAutoCompress()', () => {
  it('records hard compaction into compressionState as autocompact', async () => {
    const sessionId = `session-autocompact-${Date.now()}`;
    const ctx = {
      sessionId,
      agentId: undefined,
      messages: Array.from({ length: 6 }, (_, i) => buildMessage(
        `m${i}`,
        i === 0 ? 'user' : 'assistant',
        `message ${i} ${'hard compaction transcript '.repeat(250)}`,
      )),
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
        recordCompaction: vi.fn(),
      },
      systemPrompt: '',
      hookManager: undefined,
    };

    const assembly = new ContextAssembly(ctx as never);
    await assembly.checkAndAutoCompress();

    expect(ctx.compressionState.getCommitLog()).toHaveLength(1);
    expect(ctx.compressionState.getCommitLog()[0].layer).toBe('autocompact');
    expect(ctx.compressionState.getCommitLog()[0].targetMessageIds).toHaveLength(1);
    expect(ctx.messages.some((message: Message) => message.compaction)).toBe(true);
    expect(serviceMocks.sessionManager.addMessageToSession).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        role: 'system',
        compaction: expect.objectContaining({
          content: expect.stringContaining('summary'),
          source: 'auto_threshold',
        }),
      }),
    );
    expect(serviceMocks.sessionManager.replaceMessages).not.toHaveBeenCalled();

    // A.5 invariant: compactionMessage.content 不能混入 user-facing toast 文案，
    // 否则下次压缩会把它 summarize 进新 summary，造成递归污染。
    // 用户可读的"已压缩 / 节省 N tokens"必须走 context_compacted SSE event，不走 messages。
    const compactionMsg = ctx.messages.find((m: Message) => m.compaction);
    expect(compactionMsg, 'compaction message must exist after compaction').toBeDefined();
    expect(compactionMsg!.content).not.toMatch(/\[Compaction\]/);
    expect(compactionMsg!.content).not.toMatch(/已压缩.*条消息/);
    expect(compactionMsg!.content).not.toMatch(/节省.*tokens/);
    // 结构化字段 compaction.content 是真 source of truth — 上面已有 stringContaining('summary')。

    // A.3 invariant: 压缩后 messages 数组应为 [compactionMessage, ...lastN原消息]，
    // 且 preserveCount=2 + compaction=1 → 总长 3。
    // 边界识别按 message ID 而非位置（避免 fork/replay 时错位）。
    expect(ctx.messages).toHaveLength(3);
    expect(ctx.messages[0].compaction, 'compaction message must be at index 0').toBeDefined();
    expect(ctx.messages[0].role).toBe('system');
    expect(ctx.messages[1].id).toBe('m4');
    expect(ctx.messages[2].id).toBe('m5');
  });

  it('uses unified compaction service for percentage fallback instead of legacy autoCompressor', async () => {
    const sessionId = `session-fallback-${Date.now()}`;
    const checkAndCompress = vi.fn().mockRejectedValue(new Error('legacy checkAndCompress should not be called'));
    const messages = Array.from({ length: 8 }, (_, i) =>
      buildMessage(
        `fallback-${i}`,
        i % 2 === 0 ? 'user' : 'assistant',
        `fallback message ${i} ${'long transcript content '.repeat(250)}`,
      )
    );

    vi.mocked(getContextHealthService).mockReturnValue({
      get: vi.fn().mockReturnValue({
        usagePercent: 82,
        currentTokens: 110000,
        maxTokens: 128000,
      }),
      update: vi.fn(),
    } as never);

    const ctx = {
      sessionId,
      agentId: undefined,
      messages,
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
        shouldTriggerByTokens: vi.fn().mockReturnValue(false),
        checkAndCompress,
        getConfig: vi.fn().mockReturnValue({
          enabled: true,
          warningThreshold: 0.75,
          preserveRecentCount: 2,
        }),
        getCompactionCount: vi.fn().mockReturnValue(1),
        getStats: vi.fn().mockReturnValue({ compressionCount: 1, totalSavedTokens: 123 }),
        recordCompaction: vi.fn(),
      },
      systemPrompt: '',
      hookManager: undefined,
    };

    const assembly = new ContextAssembly(ctx as never);
    await assembly.checkAndAutoCompress();

    expect(checkAndCompress).not.toHaveBeenCalled();
    expect(ctx.autoCompressor.recordCompaction).toHaveBeenCalledWith(expect.any(Number), 'ai_summary');
    expect(ctx.compressionState.getCommitLog()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          layer: 'autocompact',
          operation: 'compact',
        }),
      ]),
    );
    expect(ctx.messages[0]).toEqual(
      expect.objectContaining({
        role: 'system',
        compaction: expect.objectContaining({
          source: 'auto_threshold',
          content: expect.stringContaining('[Context Handoff]'),
        }),
      }),
    );
    expect(serviceMocks.sessionManager.addMessageToSession).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        role: 'system',
        compaction: expect.objectContaining({
          source: 'auto_threshold',
          content: expect.stringContaining('[Context Handoff]'),
        }),
      }),
    );
    expect(serviceMocks.sessionManager.replaceMessages).not.toHaveBeenCalled();
    expect(ctx.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'context_compressed',
        data: expect.objectContaining({
          strategy: 'compaction_block',
        }),
      }),
    );
  });

  it('does not run percentage fallback compaction below the warning budget', async () => {
    const sessionId = `session-fallback-skip-${Date.now()}`;
    const checkAndCompress = vi.fn();
    const compactModelMessages = Array.from({ length: 8 }, (_, i) =>
      buildMessage(`fallback-skip-${i}`, 'assistant', 'long transcript content '.repeat(250))
    );

    vi.mocked(getContextHealthService).mockReturnValue({
      get: vi.fn().mockReturnValue({
        usagePercent: 50,
        currentTokens: 64000,
        maxTokens: 128000,
      }),
      update: vi.fn(),
    } as never);

    const ctx = {
      sessionId,
      agentId: undefined,
      messages: compactModelMessages,
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
        shouldTriggerByTokens: vi.fn().mockReturnValue(false),
        checkAndCompress,
        getConfig: vi.fn().mockReturnValue({
          enabled: true,
          warningThreshold: 0.75,
          preserveRecentCount: 2,
        }),
        getCompactionCount: vi.fn().mockReturnValue(0),
        getStats: vi.fn().mockReturnValue({ compressionCount: 0, totalSavedTokens: 0 }),
        recordCompaction: vi.fn(),
      },
      systemPrompt: '',
      hookManager: undefined,
    };

    const assembly = new ContextAssembly(ctx as never);
    await assembly.checkAndAutoCompress();

    expect(checkAndCompress).not.toHaveBeenCalled();
    expect(ctx.autoCompressor.recordCompaction).not.toHaveBeenCalled();
    expect(serviceMocks.sessionManager.replaceMessages).not.toHaveBeenCalled();
    expect(ctx.onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'context_compressed' }));
  });
});
