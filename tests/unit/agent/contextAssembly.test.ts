// ============================================================================
// ContextAssembly Tests
// Verifies runtime model input honors context interventions.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  ZHIPU_VISION_MODEL: 'vision-model',
  getCloudApiUrl: vi.fn().mockReturnValue('https://example.invalid'),
  MODEL_MAX_TOKENS: {},
  CONTEXT_WINDOWS: { 'test-model': 128000 },
  DEFAULT_CONTEXT_WINDOW: 128000,
  getContextWindow: vi.fn().mockReturnValue(128000),
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
    _isRunning: false,
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

beforeEach(() => {
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
    expect(loadRelevantSkills).not.toHaveBeenCalled();
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
        targetReadCount: 1,
        targetRangedReadCount: 1,
        noOpPatchCount: 1,
        blockedToolCount: 2,
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
    expect(systemPrompt).toContain('Edit or Append the target file now');
    expect(systemPrompt).toContain('Do not use Grep, Glob, Task, ToolSearch');
    expect(systemPrompt).toContain(`Patch ${targetFile} directly`);
    expect(systemPrompt).toContain('Keep the interactive contract tied to live gameplay state');
  });

  it('compresses large target file read history during artifact repair mode', async () => {
    const largeHtml = [
      '<!doctype html>',
      '<html>',
      '<head><title>Corgi</title></head>',
      '<body>',
      '<script>',
      'const filler = `' + 'x'.repeat(14000) + '`;',
      'const levels = [{ id: "1-1", treats: [{ x: 120, y: 200 }], enemies: [{ x: 220, y: 250 }], door: { x: 420, y: 200 } }];',
      'function updatePlayer() { player.vx += Keys.ArrowRight ? 1 : 0; player.vy += 1; }',
      'function update() { updatePlayer(); collectTreats(); stompEnemies(); completeLevel(); }',
      'function gameLoop() { update(); requestAnimationFrame(gameLoop); }',
      'function collectTreats() { State.score += 1; State.abilities.doubleJump = true; }',
      'function stompEnemies() { State.stomps = (State.stomps || 0) + 1; }',
      'function completeLevel() { State.level += 1; }',
      'window.__GAME_META__ = {',
      "  progressPlan: [{ step: 1, input: ['ArrowRight'], metric: 'score', expect: 'increase' }],",
      '};',
      'window.__GAME_TEST__ = {',
      '  start() { return true; },',
      '  reset() { return true; },',
      '  snapshot() { return { score: 0 }; },',
      '  step() { return { score: 1 }; },',
      '  runSmokeTest() { return { passed: false, failures: ["score"], coverage: {} }; },',
      '};',
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
        targetReadCount: 1,
      },
      persistentSystemContext: [
        '<artifact-validation-failed kind="interactive_artifact">\nArtifact validation failed for /tmp/game.html.\n</artifact-validation-failed>',
      ],
    });

    const assembly = new ContextAssembly(ctx as never);
    const modelMessages = await assembly.buildModelMessages();
    const toolMessage = modelMessages.find((message) => message.role === 'tool');

    expect(toolMessage?.content).toContain('<artifact-repair-file-read>');
    expect(toolMessage?.content).toContain('Target file already read: /tmp/game.html');
    expect(toolMessage?.content).toContain('Runtime structure index:');
    expect(toolMessage?.content).toContain('game-update-loop: line');
    expect(toolMessage?.content).toContain('player-physics: line');
    expect(toolMessage?.content).toContain('Runtime anchor excerpts:');
    expect(toolMessage?.content).toContain('Anchor player-physics around line');
    expect(toolMessage?.content).toContain('window.__GAME_META__');
    expect(toolMessage?.content).toContain('window.__GAME_TEST__');
    expect(toolMessage?.content).toContain('function gameLoop()');
    expect(toolMessage?.content).toContain('function update()');
    expect(toolMessage?.content).toContain('function updatePlayer()');
    expect(toolMessage?.content).toContain('Patch strategy:');
    expect(toolMessage?.content).toContain('Do not use Read/Edit as a probe');
    expect(toolMessage?.content).toContain('write the patch now');
    expect(toolMessage?.content).not.toContain('x'.repeat(4000));
  });

  it('adds focused mutation hints for duplicate or shortcut-heavy artifact contracts', async () => {
    const largeHtml = [
      '<!doctype html>',
      '<html>',
      '<body>',
      '<script>',
      'const filler = `' + 'x'.repeat(14000) + '`;',
      'window.__GAME_TEST__ = {',
      '  step() { State.abilities.dash = true; return {}; },',
      '  runSmokeTest() { mechanics.add(\"enemy_stomp\"); return { passed: true, checks: [], failures: [], coverage: {} }; },',
      '};',
      'window.__GAME_TEST__ = { runSmokeTest() { return { passed: true, checks: [], failures: [], coverage: {} }; } };',
      '</script>',
      '</body>',
      '</html>',
    ].join('\n');

    const targetFile = '/tmp/game.html';
    const ctx = buildRuntimeContext({
      messages: [
        buildMessage('user-repair-shortcut', 'user', `修复 ${targetFile}`),
        {
          id: 'tool-message-shortcut',
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
        targetReadCount: 1,
      },
      persistentSystemContext: [
        '<artifact-validation-failed kind="interactive_artifact">\nArtifact validation failed for /tmp/game.html.\n</artifact-validation-failed>',
      ],
    });

    const assembly = new ContextAssembly(ctx as never);
    const modelMessages = await assembly.buildModelMessages();
    const toolMessage = modelMessages.find((message) => message.role === 'tool');

    expect(toolMessage?.content).toContain('Multiple interactive contract anchors found');
    expect(toolMessage?.content).toContain('direct state grants or test-mode shortcuts');
    expect(toolMessage?.content).toContain('existence/registration as evidence');
    expect(toolMessage?.content).toContain('write the patch now');
    expect((toolMessage?.content || '').length).toBeLessThan(12_000);
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
        targetReadCount: 1,
        patched: false,
      },
      persistentSystemContext: [
        '<artifact-validation-failed kind="interactive_artifact">\nArtifact validation failed for /tmp/game.html.\n</artifact-validation-failed>',
      ],
    });

    const assembly = new ContextAssembly(ctx as never);
    const modelMessages = await assembly.buildModelMessages();
    const assistantMessage = modelMessages.find((message) => message.role === 'assistant');
    expect(assistantMessage?.toolCalls?.map((toolCall: any) => toolCall.name)).toEqual(['Edit']);
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
        targetReadCount: 1,
        noOpPatchCount: 1,
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

    expect(assistantMessage?.toolCalls?.map((toolCall: any) => toolCall.name)).toEqual(['Write']);
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].toolCallId).toBe('tc-write');
    expect(toolMessages[0].content).toContain('Artifact validation failed');
    expect(toolMessages[0].content).not.toContain('old read result should be filtered');
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
        targetReadCount: 1,
        noOpPatchCount: 1,
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
        targetReadCount: 1,
        targetRangedReadCount: 1,
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

  it('compresses large ranged target-file reads once artifact repair is write-priority', async () => {
    const largeRangedContract = [
      'window.__GAME_TEST__ = {',
      '  step(input, frames) { return this.snapshot(); },',
      '  runSmokeTest() {',
      '    const before = this.snapshot();',
      '    const after = this.step({ ArrowRight: true }, 80);',
      "    if (after.playerX > before.playerX) coverage.mechanics.push('movement');",
      '    return { passed: true, checks: [], failures: [], coverage: {} };',
      '  }',
      '};',
      'start() { return this.snapshot(); },',
      'reset() { return this.snapshot(); },',
      'FILLER '.repeat(3_000),
    ].join('\n');
    const ctx = buildRuntimeContext({
      messages: [
        buildMessage('user-repair-ranged-large', 'user', 'fix the game contract'),
        {
          id: 'assistant-read-range-large',
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          toolCalls: [
            {
              id: 'tc-read-range-large',
              name: 'Read',
              arguments: { file_path: '/tmp/game.html', offset: 1040, limit: 600 },
            },
          ],
        } as Message,
        {
          id: 'tool-read-range-large',
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolResults: [
            {
              toolCallId: 'tc-read-range-large',
              success: true,
              output: largeRangedContract,
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
        targetReadCount: 1,
        targetRangedReadCount: 1,
        preferTargetedEdit: true,
        noOpPatchCount: 1,
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

    expect(toolMessage?.content).toContain('<artifact-repair-file-read>');
    expect(toolMessage?.content).toContain('History preview compressed for repair mode');
    expect(toolMessage?.content).toContain('write the patch now');
    expect(toolMessage?.content).toContain('repair runtime can expand it to the balanced contract region');
    expect(toolMessage?.content).not.toContain('FILLER '.repeat(500));
    expect((toolMessage?.content || '').length).toBeLessThan(12_000);
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
      _isRunning: false,
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
