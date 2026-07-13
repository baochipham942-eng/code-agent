 
// ============================================================================
// ConversationRuntime Tests
// Tests for session initialization, message handling, state transitions,
// control methods (cancel/interrupt/steer), plan mode, structured output
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHookManager } from '../../../src/host/hooks';

const activityMocks = vi.hoisted(() => ({
  getCurrentActivityContext: vi.fn(),
  formatActivityPromptContext: vi.fn(),
}));

// --------------------------------------------------------------------------
// Mocks — must be declared before imports
// --------------------------------------------------------------------------

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/host/mcp/logCollector', () => ({
  logCollector: {
    agent: vi.fn(),
    addLog: vi.fn(),
  },
}));

vi.mock('../../../src/host/services', () => ({
  getConfigService: () => ({ getApiKey: vi.fn().mockReturnValue('mock-key') }),
  getAuthService: () => ({}),
  getLangfuseService: () => ({
    startTrace: vi.fn(),
    logEvent: vi.fn(),
    endTrace: vi.fn(),
    startSpan: vi.fn().mockReturnValue('span-1'),
    endSpan: vi.fn(),
  }),
  getBudgetService: () => ({
    checkBudget: vi.fn().mockReturnValue({ exceeded: false }),
    recordUsage: vi.fn(),
  }),
  BudgetAlertLevel: { NONE: 'none', WARNING: 'warning', CRITICAL: 'critical' },
  getSessionManager: () => ({
    getTodos: vi.fn().mockResolvedValue([]),
    saveTodos: vi.fn(),
  }),
}));

vi.mock('../../../src/host/planning/taskComplexityAnalyzer', () => ({
  taskComplexityAnalyzer: {
    analyze: vi.fn().mockReturnValue({
      complexity: 'simple',
      confidence: 0.8,
      reasons: [],
      targetFiles: [],
    }),
    generateComplexityHint: vi.fn().mockReturnValue(''),
  },
}));

vi.mock('../../../src/host/routing/intentClassifier', () => ({
  classifyIntent: vi.fn().mockResolvedValue({
    intent: 'general',
    references_past_context: false,
  }),
}));

vi.mock('../../../src/host/planning/taskOrchestrator', () => ({
  getTaskOrchestrator: () => ({
    judge: vi.fn().mockResolvedValue({ shouldParallel: false, confidence: 0.5 }),
    generateParallelHint: vi.fn().mockReturnValue(''),
  }),
}));

vi.mock('../../../src/host/services/cloud/featureFlagService', () => ({
  getMaxIterations: vi.fn().mockReturnValue(25),
}));

vi.mock('../../../src/host/hooks', () => ({
  HookManager: class MockHookManager {
    initialize = vi.fn();
    triggerUserPromptSubmit = vi.fn().mockResolvedValue({ shouldProceed: true });
    triggerSessionStart = vi.fn().mockResolvedValue({});
  },
  createHookManager: vi.fn().mockReturnValue({
    initialize: vi.fn(),
    triggerUserPromptSubmit: vi.fn().mockResolvedValue({ shouldProceed: true }),
    triggerSessionStart: vi.fn().mockResolvedValue({}),
  }),
}));

vi.mock('../../../src/host/agent/sessionRecovery', () => ({
  getSessionRecoveryService: () => ({
    checkPreviousSession: vi.fn().mockResolvedValue(null),
    saveSessionState: vi.fn(),
  }),
}));

vi.mock('../../../src/host/utils/seedMemoryInjector', () => ({
  buildPackedSeedMemory: vi.fn().mockResolvedValue(null),
  buildSeedMemoryBlock: vi.fn().mockReturnValue(null),
}));

vi.mock('../../../src/host/services/activity/activityContextProvider', () => ({
  getCurrentActivityContext: activityMocks.getCurrentActivityContext,
}));

vi.mock('../../../src/host/services/activity/activityPromptFormatter', () => ({
  formatActivityPromptContext: activityMocks.formatActivityPromptContext,
}));

vi.mock('../../../src/host/memory/desktopActivityUnderstandingService', () => ({
  getDesktopActivityUnderstandingService: () => ({
    ensureFreshData: vi.fn(),
    listTodoItems: vi.fn().mockReturnValue([]),
    syncTodoCandidatesToTasks: vi.fn().mockReturnValue({ created: [], updated: [], tasks: [], totalCandidates: 0 }),
    buildContextBlock: vi.fn().mockReturnValue(null),
  }),
}));

vi.mock('../../../src/host/memory/desktopActivityPlanningBridge', () => ({
  syncDesktopTasksToPlanningService: vi.fn().mockResolvedValue({
    createdPlan: false,
    createdPhase: false,
    addedSteps: [],
    updatedSteps: [],
  }),
}));

vi.mock('../../../src/host/memory/workspaceActivitySearchService', () => ({
  buildWorkspaceActivityContextBlock: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../src/host/planning/recoveredWorkOrchestrator', () => ({
  buildRecoveredWorkOrchestrationHint: vi.fn().mockResolvedValue(null),
  isContinuationLikeRequest: vi.fn().mockReturnValue(false),
  recoverRecentWorkIntoPlanning: vi.fn().mockResolvedValue({ planChanged: false, planningSync: { addedSteps: [] } }),
}));

vi.mock('../../../src/host/planning', () => ({
  publishPlanningStateToRenderer: vi.fn(),
}));

vi.mock('../../../src/host/agent/todoParser', () => ({
  parseTodos: vi.fn().mockReturnValue([]),
  mergeTodos: vi.fn().mockReturnValue([]),
  advanceTodoStatus: vi.fn().mockReturnValue({ todos: [] }),
  completeCurrentAndAdvance: vi.fn().mockReturnValue({ todos: [] }),
  getSessionTodos: vi.fn().mockReturnValue([]),
  setSessionTodos: vi.fn(),
  clearSessionTodos: vi.fn(),
}));

vi.mock('../../../src/host/lightMemory/sessionMetadata', () => ({
  recordSessionStart: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/host/prompts/builder', () => ({
  getPromptForTask: vi.fn().mockReturnValue(''),
  buildDynamicPromptV2: vi.fn().mockReturnValue({
    mode: 'code',
    features: {},
    modeConfig: { readOnly: false },
    reminderStats: { deduplication: { selected: 0 } },
    tokensUsed: 0,
    userMessage: 'test message',
  }),
}));

vi.mock('../../../src/host/agent/structuredOutput', () => ({
  generateFormatCorrectionPrompt: vi.fn().mockReturnValue('correction prompt'),
}));

vi.mock('../../../src/host/services/planning/taskStore', () => ({
  getIncompleteTasks: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/host/context/tokenOptimizer', () => ({
  compressToolResult: vi.fn().mockReturnValue('compressed'),
  HookMessageBuffer: class { append() {} flush() { return []; } },
  estimateModelMessageTokens: vi.fn().mockReturnValue(100),
  MessageHistoryCompressor: class { compress() {} },
  estimateTokens: vi.fn().mockReturnValue(100),
}));

vi.mock('../../../src/host/context/autoCompressor', () => ({
  AutoContextCompressor: class { compress() {} },
  getAutoCompressor: vi.fn(),
}));

vi.mock('../../../src/host/memory/sanitizeMemoryContent', () => ({
  sanitizeMemoryContent: vi.fn().mockReturnValue('sanitized'),
}));

vi.mock('../../../src/host/agent/runtime/messageProcessor', () => ({
  MessageProcessor: class MockMessageProcessor {
    handleTextResponse = vi.fn().mockResolvedValue('break');
    handleToolResponse = vi.fn().mockResolvedValue('continue');
    detectAndForceExecuteTextToolCall = vi.fn().mockReturnValue({ shouldContinue: false, response: { type: 'text', content: 'done' }, wasForceExecuted: false });
    recordModelCallTelemetry = vi.fn();
    injectSteerMessage = vi.fn();
    generateTruncationWarning = vi.fn().mockReturnValue('Warning: context truncated');
    generateAutoContinuationPrompt = vi.fn().mockReturnValue('Continue...');
  },
}));

vi.mock('../../../src/host/agent/runtime/streamHandler', () => ({
  StreamHandler: class MockStreamHandler {
    setupIteration = vi.fn();
    injectPlanContext = vi.fn();
    injectContextualMemory = vi.fn();
    emitModelResponse = vi.fn();
  },
}));

vi.mock('../../../src/shared/constants', () => ({
  DEFAULT_MODELS: {},
  MODEL_MAX_TOKENS: {},
  CONTEXT_WINDOWS: {},
  DEFAULT_CONTEXT_WINDOW: 128000,
  PROMPT_VERSION: 'sys-test',
  getContextWindow: vi.fn().mockReturnValue(128000),
  ACTIVE_TOOL_RESULT_PRUNE: { ENABLED: true, MAX_TOKENS_PER_RESULT: 4096 },
  GOAL_MODE: {
    DEFAULT_TOKEN_BUDGET: 100_000,
    DEFAULT_MAX_TURNS: 5,
    NO_PROGRESS_THRESHOLD: 3,
    CHECKPOINT_INTERVAL: 3,
  },
  TOOL_PROGRESS: {},
  TOOL_TIMEOUT_THRESHOLDS: {},
}));

vi.mock('../../../src/host/model/modelRouter', () => ({
  ModelRouter: class {},
  ContextLengthExceededError: class extends Error {},
}));

vi.mock('../../../src/host/context/contextHealthService', () => ({
  getContextHealthService: vi.fn(),
}));

vi.mock('../../../src/host/telemetry/systemPromptCache', () => ({
  getSystemPromptCache: vi.fn(),
}));

vi.mock('../../../src/host/security/inputSanitizer', () => ({
  getInputSanitizer: vi.fn(),
}));

vi.mock('../../../src/host/services/diff/diffTracker', () => ({
  getDiffTracker: vi.fn(),
}));

vi.mock('../../../src/host/services/citation/citationService', () => ({
  getCitationService: vi.fn(),
}));

vi.mock('../../../src/host/tools/fileReadTracker', () => ({
  fileReadTracker: { getRecentFiles: vi.fn().mockReturnValue([]) },
}));

vi.mock('../../../src/host/tools/dataFingerprint', () => ({
  dataFingerprintStore: {},
}));

vi.mock('../../../src/host/agent/loopTypes', () => ({
  MAX_PARALLEL_TOOLS: 4,
}));

vi.mock('../../../src/host/agent/toolExecution/parallelStrategy', () => ({
  isParallelSafeTool: vi.fn(),
  classifyToolCalls: vi.fn(),
}));

vi.mock('../../../src/host/agent/toolExecution/circuitBreaker', () => ({
  CircuitBreaker: class {
    isTripped = vi.fn().mockReturnValue(false);
    recordSuccess = vi.fn();
    recordFailure = vi.fn();
    reset = vi.fn();
  },
}));

vi.mock('../../../src/host/tools/executionPhase', () => ({
  classifyExecutionPhase: vi.fn(),
}));

vi.mock('../../../src/host/agent/messageHandling/converter', () => ({
  formatToolCallForHistory: vi.fn(),
  sanitizeToolResultsForHistory: vi.fn(),
  buildMultimodalContent: vi.fn(),
  stripImagesFromMessages: vi.fn(),
  extractUserRequestText: vi.fn(),
}));

vi.mock('../../../src/host/agent/messageHandling/contextBuilder', () => ({
  buildGitStatusBlock: vi.fn(() => ''),
  injectWorkingDirectoryContext: vi.fn(),
  buildEnhancedSystemPrompt: vi.fn().mockReturnValue('system prompt'),
  buildRuntimeModeBlock: vi.fn().mockReturnValue(''),
}));

vi.mock('../../../src/host/agent/antiPattern/detector', () => ({
  AntiPatternDetector: class {
    detect = vi.fn().mockReturnValue([]);
    reset = vi.fn();
  },
}));

vi.mock('../../../src/host/agent/antiPattern/cleanXml', () => ({
  cleanXmlResidues: vi.fn().mockReturnValue(''),
}));

vi.mock('../../../src/host/agent/goalTracker', () => ({
  GoalTracker: class {
    initialize = vi.fn();
    shouldInject = vi.fn().mockReturnValue(false);
    buildInjection = vi.fn().mockReturnValue('');
    recordAction = vi.fn();
    getGoal = vi.fn().mockReturnValue('');
  },
}));

vi.mock('../../../src/shared/utils/id', () => ({
  generateMessageId: vi.fn().mockReturnValue('mock-msg-id'),
}));

vi.mock('../../../src/host/memory/continuousLearningService', () => ({
  getContinuousLearningService: vi.fn(),
}));

vi.mock('../../../src/host/services/toolSearch', () => ({
  getToolSearchService: vi.fn(),
}));

vi.mock('../../../src/host/services/skills/skillInvocationResolver', () => ({
  resolveSkillInvocation: vi.fn().mockResolvedValue(null),
  buildSkillInvocationContext: vi.fn(),
}));

// --------------------------------------------------------------------------
// Import after mocks
// --------------------------------------------------------------------------

import { ConversationRuntime } from '../../../src/host/agent/runtime/conversationRuntime';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import { GoalModeController } from '../../../src/host/agent/goalModeController';
import { buildPackedSeedMemory, buildSeedMemoryBlock } from '../../../src/host/utils/seedMemoryInjector';
import {
  clearMemoryInjectionTracesForTest,
  listMemoryInjectionTraces,
} from '../../../src/host/memory/memoryInjectionTrace';
import {
  buildSkillInvocationContext,
  resolveSkillInvocation,
} from '../../../src/host/services/skills/skillInvocationResolver';

// --------------------------------------------------------------------------
// Helper — create a minimal RuntimeContext mock
// --------------------------------------------------------------------------

function createMockContext(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    systemPrompt: 'You are an AI assistant.',
    modelConfig: { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 8192 },
    toolRegistry: { getTools: vi.fn().mockReturnValue([]), getTool: vi.fn() } as any,
    toolExecutor: { execute: vi.fn() } as any,
    messages: [],
    onEvent: vi.fn(),
    modelRouter: {} as any,
    maxIterations: 25,
    workingDirectory: '/tmp/test',
    isDefaultWorkingDirectory: true,
    sessionId: 'test-session-1',
    userId: 'test-user',

    circuitBreaker: {
      isTripped: vi.fn().mockReturnValue(false),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
      reset: vi.fn(),
    } as any,
    antiPatternDetector: { detect: vi.fn().mockReturnValue([]), reset: vi.fn() } as any,
    goalTracker: { initialize: vi.fn(), shouldInject: vi.fn().mockReturnValue(false), buildInjection: vi.fn().mockReturnValue(''), recordAction: vi.fn(), getGoal: vi.fn().mockReturnValue('') } as any,
    nudgeManager: { check: vi.fn().mockReturnValue(null) } as any,
    hookMessageBuffer: { append: vi.fn(), flush: vi.fn().mockReturnValue([]) } as any,
    messageHistoryCompressor: { compress: vi.fn() } as any,
    autoCompressor: { compress: vi.fn() } as any,

    isCancelled: false,
    isInterrupted: false,
    isPaused: false,
    interruptMessage: null,
    needsReinference: false,
    abortController: null,
    runAbortController: null,

    isPlanModeActive: false,
    savedMessages: null,
    autoApprovePlan: false,

    enableHooks: false,
    userHooksInitialized: false,
    maxStopHookRetries: 3,

    maxToolCallRetries: 3,
    externalDataCallCount: 0,
    preApprovedTools: new Set(),
    enableToolDeferredLoading: false,

    structuredOutputRetryCount: 0,
    maxStructuredOutputRetries: 3,

    stepByStepMode: false,

    traceId: '',
    turnTrace: {
      setTurn: () => {},
      record: () => {},
      flush: () => {},
      getEvents: () => [],
    } as any,
    currentIterationSpanId: '',
    currentTurnId: '',
    pendingRuntimeDiagnostics: [],
    forceFinalResponseReason: undefined,
    forceFinalResponsePrompt: undefined,

    turnStartTime: 0,
    toolsUsedInTurn: [],
    isSimpleTaskMode: true,

    _researchModeActive: false,
    _researchIterationCount: 0,

    budgetWarningEmitted: false,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    consecutiveErrors: 0,

    effortLevel: 'normal' as any,
    thinkingStepCount: 0,

    runStartTime: 0,
    totalTokensUsed: 0,
    totalToolCallCount: 0,

    _contextOverflowRetried: false,
    _artifactNonStreamingRetried: false,
    _networkRetried: false,
    MAX_CONSECUTIVE_TRUNCATIONS: 3,

    persistentSystemContext: [],


    ...overrides,
  } as RuntimeContext;
}

function createMockModules() {
  return {
    toolEngine: {
      executeToolCalls: vi.fn(),
      executeSingleTool: vi.fn(),
    } as any,
    contextAssembly: {
      inference: vi.fn().mockResolvedValue({ type: 'text', content: 'Hello!' }),
      injectSystemMessage: vi.fn(),
      injectResearchModePrompt: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
      checkAndAutoCompress: vi.fn(),
      addAndPersistMessage: vi.fn(),
    } as any,
    runFinalizer: {
      finalizeRun: vi.fn(),
      checkAndEmitBudgetStatus: vi.fn().mockReturnValue(false),
      emitTaskProgress: vi.fn(),
      emitTaskComplete: vi.fn(),
      tryParseTodosFromResponse: vi.fn(),
    } as any,
    learningPipeline: {
      learn: vi.fn(),
    } as any,
  };
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('ConversationRuntime', () => {
  let ctx: RuntimeContext;
  let runtime: ConversationRuntime;
  let modules: ReturnType<typeof createMockModules>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearMemoryInjectionTracesForTest();
    vi.mocked(buildPackedSeedMemory).mockResolvedValue(null);
    vi.mocked(buildSeedMemoryBlock).mockReturnValue(null);
    activityMocks.getCurrentActivityContext.mockResolvedValue({
      generatedAtMs: 1_800_000,
      maxChars: 1_000,
      tokenBudgetHint: { maxChars: 1_000, targetTokens: 250 },
      sources: [],
      evidenceRefs: [],
    });
    activityMocks.formatActivityPromptContext.mockReturnValue({
      mode: 'legacySeparate',
      screenMemoryBlock: 'screen context from activity provider',
      desktopActivityBlock: 'desktop context from activity provider',
    });
    ctx = createMockContext();
    runtime = new ConversationRuntime(ctx);
    modules = createMockModules();
    runtime.setModules(modules.toolEngine, modules.contextAssembly, modules.runFinalizer, modules.learningPipeline);
  });

  // ==========================================================================
  // Initialization
  // ==========================================================================

  describe('setModules', () => {
    it('should set all module references', () => {
      expect(runtime.toolEngine).toBe(modules.toolEngine);
      expect(runtime.contextAssembly).toBe(modules.contextAssembly);
      expect(runtime.runFinalizer).toBe(modules.runFinalizer);
      expect(runtime.learningPipeline).toBe(modules.learningPipeline);
    });
  });

  // ==========================================================================
  // Plan Mode
  // ==========================================================================

  describe('plan mode', () => {
    it('should start with plan mode inactive', () => {
      expect(runtime.isPlanMode()).toBe(false);
    });

    it('should activate plan mode and save messages', () => {
      ctx.messages.push({ role: 'user', content: 'hello' } as any);
      runtime.setPlanMode(true);

      expect(runtime.isPlanMode()).toBe(true);
      expect(ctx.isPlanModeActive).toBe(true);
      expect(ctx.savedMessages).toHaveLength(1);
      expect(modules.contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
        expect.stringContaining('PLAN MODE')
      );
    });

    it('should deactivate plan mode and restore messages', () => {
      const originalMessages = [{ role: 'user', content: 'original' }] as any[];
      ctx.messages.push(...originalMessages);

      runtime.setPlanMode(true);
      // Add plan-mode messages
      ctx.messages.push({ role: 'assistant', content: 'plan step 1' } as any);
      expect(ctx.messages).toHaveLength(2);

      runtime.setPlanMode(false);
      expect(runtime.isPlanMode()).toBe(false);
      expect(ctx.messages).toHaveLength(1);
      expect(ctx.messages[0].content).toBe('original');
    });
  });

  // ==========================================================================
  // Structured Output
  // ==========================================================================

  describe('structured output', () => {
    it('should set and get structured output config', () => {
      const config = { schema: { type: 'object' }, format: 'json' } as any;
      runtime.setStructuredOutput(config);

      expect(runtime.getStructuredOutput()).toBe(config);
      expect(ctx.structuredOutputRetryCount).toBe(0);
    });

    it('should clear structured output config', () => {
      runtime.setStructuredOutput({ schema: {}, format: 'json' } as any);
      runtime.setStructuredOutput(undefined);
      expect(runtime.getStructuredOutput()).toBeUndefined();
    });

    it('shouldRetryStructuredOutput returns false on success', () => {
      runtime.setStructuredOutput({ schema: {}, format: 'json' } as any);
      expect(runtime.shouldRetryStructuredOutput({ success: true } as any)).toBe(false);
    });

    it('shouldRetryStructuredOutput returns true when retries remain', () => {
      runtime.setStructuredOutput({ schema: {}, format: 'json' } as any);
      ctx.structuredOutputRetryCount = 0;
      expect(runtime.shouldRetryStructuredOutput({ success: false } as any)).toBe(true);
    });

    it('shouldRetryStructuredOutput returns false when max retries reached', () => {
      runtime.setStructuredOutput({ schema: {}, format: 'json' } as any);
      ctx.structuredOutputRetryCount = 3;
      ctx.maxStructuredOutputRetries = 3;
      expect(runtime.shouldRetryStructuredOutput({ success: false } as any)).toBe(false);
    });

    it('injectStructuredOutputCorrection should increment retry count', () => {
      ctx.structuredOutput = { schema: { type: 'object' }, format: 'json' } as any;
      ctx.structuredOutputRetryCount = 0;

      runtime.injectStructuredOutputCorrection({
        success: false,
        rawContent: '{ bad json',
        validationErrors: ['Invalid JSON'],
      } as any);

      expect(ctx.structuredOutputRetryCount).toBe(1);
      expect(modules.contextAssembly.injectSystemMessage).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Control: cancel / interrupt / steer
  // ==========================================================================

  describe('cancel', () => {
    it('should set isCancelled flag', () => {
      runtime.cancel();
      expect(ctx.isCancelled).toBe(true);
    });

    it('should abort the abort controller', () => {
      const controller = new AbortController();
      ctx.abortController = controller;

      runtime.cancel();
      expect(controller.signal.aborted).toBe(true);
    });

    it('should abort the run-level controller', () => {
      const controller = new AbortController();
      ctx.runAbortController = controller;

      runtime.cancel();
      expect(controller.signal.aborted).toBe(true);
    });

    it('persists partial streamed assistant content as cancelled marker', async () => {
      const persistMessage = vi.fn();
      ctx.lastStreamedContent = 'partial response';
      ctx.persistMessage = persistMessage;

      await runtime.cancel();

      expect(ctx.messages.at(-1)).toMatchObject({
        role: 'assistant',
        content: 'partial response\n\n[cancelled]',
      });
      expect(persistMessage).toHaveBeenCalledWith(ctx.messages.at(-1));
      expect(ctx.lastStreamedContent).toBe('');
    });
  });

  describe('interrupt', () => {
    it('should set interrupt state and abort controller', () => {
      const controller = new AbortController();
      ctx.abortController = controller;

      runtime.interrupt('新的指令');

      expect(ctx.isInterrupted).toBe(true);
      expect(ctx.interruptMessage).toBe('新的指令');
      expect(controller.signal.aborted).toBe(true);
    });

    it('wasInterrupted should reflect interrupt state', () => {
      expect(runtime.wasInterrupted()).toBe(false);
      runtime.interrupt('test');
      expect(runtime.wasInterrupted()).toBe(true);
    });

    it('getInterruptMessage should return the interrupt message', () => {
      expect(runtime.getInterruptMessage()).toBeNull();
      runtime.interrupt('urgent');
      expect(runtime.getInterruptMessage()).toBe('urgent');
    });
  });

  describe('steer', () => {
    it('should abort controller and set needsReinference', () => {
      const controller = new AbortController();
      ctx.abortController = controller;

      runtime.steer('new direction');

      expect(controller.signal.aborted).toBe(true);
      expect(ctx.needsReinference).toBe(true);
    });

    it('passes the renderer optimistic message id to the steer injector', () => {
      runtime.steer('new direction', 'client-message-1');

      expect((runtime as any).messageProcessor.injectSteerMessage).toHaveBeenCalledWith(
        'new direction',
        'client-message-1',
        undefined,
        undefined,
      );
    });
  });

  // ==========================================================================
  // isRunning
  // ==========================================================================

  describe('isRunning', () => {
    it('should return true when not cancelled and not interrupted', () => {
      expect(runtime.isRunning()).toBe(true);
    });

    it('should return false when cancelled', () => {
      runtime.cancel();
      expect(runtime.isRunning()).toBe(false);
    });

    it('should return false when interrupted', () => {
      runtime.interrupt('stop');
      expect(runtime.isRunning()).toBe(false);
    });
  });

  // ==========================================================================
  // Effort Level
  // ==========================================================================

  describe('effort level', () => {
    it('should set and get effort level', () => {
      runtime.setEffortLevel('high' as any);
      expect(runtime.getEffortLevel()).toBe('high');
      expect(ctx.thinkingStepCount).toBe(0);
    });

    it('should reset thinking step count when changing effort level', () => {
      ctx.thinkingStepCount = 5;
      runtime.setEffortLevel('low' as any);
      expect(ctx.thinkingStepCount).toBe(0);
    });
  });

  // ==========================================================================
  // Step-by-step mode
  // ==========================================================================

  describe('parseMultiStepTask', () => {
    it('should detect numbered steps', () => {
      const result = runtime.parseMultiStepTask(
        '请按以下步骤执行:\n1. 创建文件\n2. 写入内容\n3. 运行测试'
      );
      expect(result.isMultiStep).toBe(true);
      expect(result.steps).toHaveLength(3);
      expect(result.steps[0]).toBe('创建文件');
    });

    it('should detect bullet-point steps', () => {
      const result = runtime.parseMultiStepTask(
        '任务列表:\n- 分析代码\n- 修复 bug\n- 提交更改'
      );
      expect(result.isMultiStep).toBe(true);
      expect(result.steps).toHaveLength(3);
    });

    it('should return isMultiStep false for single-line prompts', () => {
      const result = runtime.parseMultiStepTask('帮我修复这个 bug');
      expect(result.isMultiStep).toBe(false);
      expect(result.steps).toHaveLength(0);
    });

    it('should return isMultiStep false for a single step', () => {
      const result = runtime.parseMultiStepTask('1. 只有一个步骤');
      expect(result.isMultiStep).toBe(false);
      expect(result.steps).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Delegation helpers
  // ==========================================================================

  describe('delegation helpers', () => {
    it('generateAutoContinuationPrompt 返回续写指引', () => {
      const prompt = runtime.generateAutoContinuationPrompt();
      expect(prompt).toContain('auto-continuation-required');
    });

    it('getPlanningService should return from context', () => {
      expect(runtime.getPlanningService()).toBeUndefined();
      const mockPlanning = { createPlan: vi.fn() };
      ctx.planningService = mockPlanning as any;
      expect(runtime.getPlanningService()).toBe(mockPlanning);
    });
  });

  // ==========================================================================
  // initializeUserHooks
  // ==========================================================================

  describe('initializeUserHooks', () => {
    it('should skip if already initialized', async () => {
      ctx.userHooksInitialized = true;
      await runtime.initializeUserHooks();
      // No hookManager created — no assertion needed, just ensure no throw
    });

    it('should create hook manager when enableHooks is true', async () => {
      ctx.enableHooks = true;
      ctx.hookManager = undefined;
      ctx.workingDirectory = '/tmp/comate-zulu-demo';
      await runtime.initializeUserHooks();
      expect(ctx.userHooksInitialized).toBe(true);
      expect(createHookManager).toHaveBeenCalledWith(
        expect.objectContaining({ workingDirectory: '/tmp/comate-zulu-demo' })
      );
    });

    it('should initialize existing hook manager', async () => {
      const mockHookManager = {
        initialize: vi.fn(),
      };
      ctx.hookManager = mockHookManager as any;
      await runtime.initializeUserHooks();
      expect(mockHookManager.initialize).toHaveBeenCalled();
      expect(ctx.userHooksInitialized).toBe(true);
    });
  });

  // ==========================================================================
  // run() — integration-level behavior
  // ==========================================================================

  describe('run', () => {
    it('runs SessionStart hooks only for the first user turn in a chat session', async () => {
      const triggerSessionStart = vi.fn().mockResolvedValue({});
      ctx.enableHooks = true;
      ctx.hookManager = {
        initialize: vi.fn(),
        triggerUserPromptSubmit: vi.fn().mockResolvedValue({ shouldProceed: true }),
        triggerSessionStart,
      } as any;

      ctx.currentTurnId = 'stale-turn-id';
      ctx.messages = [
        { id: 'user-1', role: 'user', content: 'first', timestamp: 100 },
      ] as any;
      await runtime.initializeRun('test message');

      expect(ctx.currentTurnId).toBe('');
      expect(triggerSessionStart).toHaveBeenCalledTimes(1);

      triggerSessionStart.mockClear();
      ctx.messages = [
        { id: 'user-1', role: 'user', content: 'first', timestamp: 100 },
        { id: 'assistant-1', role: 'assistant', content: 'done', timestamp: 180 },
        { id: 'user-2', role: 'user', content: 'second', timestamp: 220 },
      ] as any;
      await runtime.initializeRun('test message');

      expect(triggerSessionStart).not.toHaveBeenCalled();
    });

    it('injects activity context through legacy screen-memory tag for simple tasks', async () => {
      await runtime.initializeRun('hello');

      expect(activityMocks.getCurrentActivityContext).toHaveBeenCalled();
      expect(activityMocks.formatActivityPromptContext).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ mode: 'legacySeparate' }),
      );
      expect(modules.contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
        '<screen-memory>\nscreen context from activity provider\n</screen-memory>'
      );
      expect(modules.contextAssembly.injectSystemMessage).not.toHaveBeenCalledWith(
        '<desktop-activity-context>\ndesktop context from activity provider\n</desktop-activity-context>'
      );
    });

    it('records seed-memory injection trace when the seed block is injected', async () => {
      vi.mocked(buildSeedMemoryBlock).mockReturnValueOnce('## Stored Memories\n- [Preference]: Use concise Chinese');

      await runtime.initializeRun('hello');

      expect(modules.contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
        '<seed-memory>\n## Stored Memories\n- [Preference]: Use concise Chinese\n</seed-memory>'
      );
      expect(listMemoryInjectionTraces({ sessionId: 'test-session-1' })).toContainEqual(
        expect.objectContaining({
          blockType: 'seed-memory',
          trigger: 'session_start',
          chars: '## Stored Memories\n- [Preference]: Use concise Chinese'.length,
          injected: true,
          source: 'database-seed',
          count: 1,
          sessionId: 'test-session-1',
        }),
      );
    });

    it('prefers packed seed-memory and records the packer source', async () => {
      // buildPackedSeedMemory 返回 { block, packed }（旧 buildPackedSeedMemoryBlock 返回纯字符串）
      vi.mocked(buildPackedSeedMemory).mockResolvedValueOnce({
        block: '## Packed Memories\n<memory-pack>\n- [1] Use concise Chinese\n</memory-pack>',
        packed: { items: [], selectedCount: 1, totalCandidates: 1 } as any,
      });

      await runtime.initializeRun('memory query');

      expect(buildSeedMemoryBlock).not.toHaveBeenCalled();
      expect(modules.contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
        '<seed-memory>\n## Packed Memories\n<memory-pack>\n- [1] Use concise Chinese\n</memory-pack>\n</seed-memory>'
      );
      expect(listMemoryInjectionTraces({ sessionId: 'test-session-1' })).toContainEqual(
        expect.objectContaining({
          blockType: 'seed-memory',
          trigger: 'session_start',
          source: 'memory-packer',
          count: 1,
          sessionId: 'test-session-1',
        }),
      );
    });

    it('promotes explicit skill invocation into required runtime context', async () => {
      const markSemanticProgress = vi.fn();
      ctx.antiPatternDetector = { ...ctx.antiPatternDetector, markSemanticProgress } as any;
      vi.mocked(resolveSkillInvocation).mockResolvedValueOnce({
        skill: {
          name: 'lobster',
          description: '龙虾 skill',
          promptContent: '',
          basePath: '/tmp/lobster',
          allowedTools: [],
          disableModelInvocation: true,
          userInvocable: true,
          executionContext: 'inline',
          source: 'user',
        },
        matchKind: 'slash',
        matchedText: '/lobster',
        args: '升级',
        confidence: 1,
        aliases: ['lobster', '龙虾'],
        reason: 'explicit slash command',
      });
      vi.mocked(buildSkillInvocationContext).mockResolvedValueOnce({
        block: '<required-skill-invocation name="lobster">...</required-skill-invocation>',
        contextModifier: { modelOverride: 'special-model' },
      });

      const result = await runtime.initializeRun('/lobster 升级');

      expect(result?.isSimpleTask).toBe(false);
      expect(ctx.activeSkillInvocation).toMatchObject({
        skillName: 'lobster',
        matchKind: 'slash',
        matchedText: '/lobster',
      });
      expect(ctx.activeSkillContextBlock).toContain('required-skill-invocation');
      expect(ctx.skillModelOverride).toBe('special-model');
      expect(markSemanticProgress).toHaveBeenCalledWith('skill invocation resolved: lobster');
    });

    it('restores strict role-edit skill context from a prior slash seed on follow-up turns', async () => {
      const markSemanticProgress = vi.fn();
      ctx.antiPatternDetector = { ...ctx.antiPatternDetector, markSemanticProgress } as any;
      ctx.messages = [
        {
          id: 'm-seed',
          role: 'user',
          content: '/edit-role 研究员',
          timestamp: 1,
        },
        {
          id: 'm-assistant',
          role: 'assistant',
          content: '当前研究员角色是调研专家。你想改什么？',
          timestamp: 2,
        },
      ];

      const invocation = {
        skill: {
          name: 'edit-role',
          description: '对话式修改角色',
          promptContent: '',
          basePath: '',
          allowedTools: ['propose_role', 'read_file', 'ask_user_question', 'glob', 'grep'],
          strictToolset: true,
          disableModelInvocation: false,
          userInvocable: true,
          executionContext: 'inline',
          source: 'builtin',
        },
        matchKind: 'slash',
        matchedText: '/edit-role',
        args: '研究员',
        confidence: 1,
        aliases: ['edit-role'],
        reason: 'explicit slash command',
      } as const;

      vi.mocked(resolveSkillInvocation)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(invocation as any);
      vi.mocked(buildSkillInvocationContext).mockResolvedValueOnce({
        block: '<required-skill-invocation name="edit-role">...</required-skill-invocation>',
        contextModifier: {
          preApprovedTools: invocation.skill.allowedTools,
          toolBoundary: {
            skillName: 'edit-role',
            allowedTools: invocation.skill.allowedTools,
            strict: true,
          },
        },
      });

      const result = await runtime.initializeRun('描述改成专盯 AI 赛道竞品的高级研究员，加 WebFetch。');

      expect(result?.isSimpleTask).toBe(false);
      expect(resolveSkillInvocation).toHaveBeenNthCalledWith(1, '描述改成专盯 AI 赛道竞品的高级研究员，加 WebFetch。', '/tmp/test');
      expect(resolveSkillInvocation).toHaveBeenNthCalledWith(2, '/edit-role 研究员', '/tmp/test');
      expect(ctx.activeSkillInvocation).toMatchObject({
        skillName: 'edit-role',
        matchKind: 'slash',
        matchedText: '/edit-role',
      });
      expect(ctx.activeSkillContextBlock).toContain('required-skill-invocation');
      expect(ctx.skillToolBoundary).toEqual({
        skillName: 'edit-role',
        allowedTools: ['propose_role', 'read_file', 'ask_user_question', 'glob', 'grep'],
        strict: true,
      });
      expect([...ctx.preApprovedTools]).toEqual(['propose_role', 'read_file', 'ask_user_question', 'glob', 'grep']);
      expect(markSemanticProgress).toHaveBeenCalledWith('skill invocation resolved: edit-role');
    });

    it('can inject desktop activity through the ActivityContext legacy formatter', async () => {
      await (runtime as any).injectActivityContext({ includeDesktopActivity: true });

      expect(modules.contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
        '<screen-memory>\nscreen context from activity provider\n</screen-memory>'
      );
      expect(modules.contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
        '<desktop-activity-context>\ndesktop context from activity provider\n</desktop-activity-context>'
      );
    });

    it('does not abort the run when desktop-derived context bootstrap fails (DB unavailable)', async () => {
      // 解析出 skill → isSimpleTask=false → 进入 bootstrapDesktopDerivedContext 分支
      vi.mocked(resolveSkillInvocation).mockResolvedValueOnce({
        skill: {
          name: 'lobster',
          description: '',
          promptContent: '',
          basePath: '/tmp/x',
          allowedTools: [],
          disableModelInvocation: true,
          userInvocable: true,
          executionContext: 'inline',
          source: 'user',
        },
        matchKind: 'slash',
        matchedText: '/lobster',
        args: '',
        confidence: 1,
        aliases: ['lobster'],
        reason: 'explicit',
      });
      vi.mocked(buildSkillInvocationContext).mockResolvedValueOnce({
        block: '<required-skill-invocation/>',
        contextModifier: {},
      });
      // desktop-derived 上下文依赖 DB；模拟 DB 未初始化 / 瞬时不可用导致抛错。
      // 回归保护：context 增强抛错绝不能让整个 run 在主循环前崩掉。
      const bootstrapSpy = vi
        .spyOn(runtime as unknown as { bootstrapDesktopDerivedContext: () => Promise<void> }, 'bootstrapDesktopDerivedContext')
        .mockRejectedValue(new Error('Database not initialized'));

      const result = await runtime.initializeRun('创建一个名为 test-x.txt 的文件');

      expect(bootstrapSpy).toHaveBeenCalled();
      expect(result).not.toBeNull();
      expect(result?.isSimpleTask).toBe(false);
    });

    it('should call initializeRun and finalizeRun on a simple task', async () => {
      // Mock inference returns text response that causes 'break'
      modules.contextAssembly.inference.mockResolvedValue({
        type: 'text',
        content: 'Done!',
      });

      await runtime.run('hello');

      expect(modules.runFinalizer.finalizeRun).toHaveBeenCalled();
      expect(ctx.goalTracker.initialize).toHaveBeenCalledWith('hello');
    });

    it('forces a tool-free three-part summary when max iterations is reached (roadmap 1.6)', async () => {
      ctx.maxIterations = 2;
      // 第一轮：steer 触发 re-inference，让循环进入第二轮（最后一轮）
      modules.contextAssembly.inference
        .mockImplementationOnce(async () => {
          ctx.needsReinference = true;
          return { type: 'text', content: 'partial' };
        })
        .mockImplementationOnce(async () => {
          // 最后一轮：max-steps 兜底应已激活（禁用工具走 forceFinalResponseReason 通道）
          expect(ctx.forceFinalResponseReason).toBeTruthy();
          expect(ctx.forceFinalResponsePrompt).toContain('MAXIMUM STEPS REACHED');
          return { type: 'text', content: 'Maximum steps reached. Summary of work done.' };
        });

      await runtime.run('long task');

      expect(modules.contextAssembly.inference).toHaveBeenCalledTimes(2);
      // run 退出时 finally 兜底清理 forced-final 标志（codex audit R2），
      // 激活本身已在第二次 inference 的 mock 内断言
      expect(ctx.forceFinalResponseReason).toBeUndefined();
      expect(modules.runFinalizer.finalizeRun).toHaveBeenCalledWith(
        expect.any(Number),
        'long task',
        expect.anything(),
        expect.any(Number),
        expect.objectContaining({ status: 'completed' }),
      );
    });

    it('clears forced-final flags on run exit even when the final inference returns empty (codex audit R2)', async () => {
      ctx.maxIterations = 2;
      const mp = (runtime as unknown as {
        messageProcessor: { detectAndForceExecuteTextToolCall: ReturnType<typeof vi.fn> };
      }).messageProcessor;
      mp.detectAndForceExecuteTextToolCall.mockImplementation((response: unknown) => ({
        shouldContinue: false,
        response,
        wasForceExecuted: false,
      }));
      modules.contextAssembly.inference
        .mockImplementationOnce(async () => {
          ctx.needsReinference = true;
          return { type: 'text', content: 'partial' };
        })
        // 最后一轮 forced-final 推理返回空文本：flag 不能泄漏到下一次用户输入
        .mockImplementationOnce(async () => ({ type: 'text', content: '' }));

      await runtime.run('long task');

      expect(ctx.forceFinalResponseReason).toBeUndefined();
      expect(ctx.forceFinalResponsePrompt).toBeUndefined();
    });

    it('does not force a summary when the run completes before max iterations', async () => {
      ctx.maxIterations = 5;
      modules.contextAssembly.inference.mockResolvedValue({ type: 'text', content: 'Done!' });

      await runtime.run('quick task');

      expect(ctx.forceFinalResponsePrompt).toBeUndefined();
      expect(ctx.forceFinalResponseReason).toBeUndefined();
    });

    it('aborts the run when the model keeps repeating the same tool call (doom loop, roadmap 1.2)', async () => {
      // mock 的 detectAndForceExecuteTextToolCall 默认会替换 response，这里改为透传
      const mp = (runtime as unknown as {
        messageProcessor: { detectAndForceExecuteTextToolCall: ReturnType<typeof vi.fn> };
      }).messageProcessor;
      mp.detectAndForceExecuteTextToolCall.mockImplementation((response: unknown) => ({
        shouldContinue: false,
        response,
        wasForceExecuted: false,
      }));
      // 每轮都返回完全相同的 tool_use；mock MessageProcessor.handleToolResponse 返回 'continue'
      modules.contextAssembly.inference.mockResolvedValue({
        type: 'tool_use',
        toolCalls: [{ id: 't1', name: 'Read', arguments: { path: 'a.ts' } }],
      });

      await runtime.run('loop forever');

      // ×3 触发 nudge，×4 升级 abort：共 4 次 inference
      expect(modules.contextAssembly.inference).toHaveBeenCalledTimes(4);
      expect(modules.contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
        expect.stringContaining('<doom-loop-guard>'),
      );
      expect(modules.runFinalizer.finalizeRun).toHaveBeenCalledWith(
        expect.any(Number),
        'loop forever',
        expect.anything(),
        expect.any(Number),
        expect.objectContaining({ status: 'aborted' }),
      );
    });

    it('auto-continues empty text output with a nudge, capped (roadmap 1.2 L3)', async () => {
      const mp = (runtime as unknown as {
        messageProcessor: { detectAndForceExecuteTextToolCall: ReturnType<typeof vi.fn> };
      }).messageProcessor;
      mp.detectAndForceExecuteTextToolCall.mockImplementation((response: unknown) => ({
        shouldContinue: false,
        response,
        wasForceExecuted: false,
      }));
      modules.contextAssembly.inference.mockResolvedValue({ type: 'text', content: '' });

      await runtime.run('empty answers');

      // 3 次续接 + 第 4 次达上限停止
      expect(modules.contextAssembly.inference).toHaveBeenCalledTimes(4);
      expect(modules.contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
        expect.stringContaining('no usable answer'),
      );
      expect(modules.runFinalizer.finalizeRun).toHaveBeenCalledWith(
        expect.any(Number),
        'empty answers',
        expect.anything(),
        expect.any(Number),
        expect.objectContaining({ status: 'completed' }),
      );
    });

    it('maps goal aborted status to aborted terminal when loop exits normally (codex audit R1)', async () => {
      // goal 在闸内被判 impossible → markAborted；loop 随后自然退出，
      // 收尾必须映射 aborted 而不是默认 completed
      ctx.goalMode = {
        isPending: vi.fn().mockReturnValue(false),
        getStatus: vi.fn().mockReturnValue('aborted'),
      } as any;
      modules.contextAssembly.inference.mockResolvedValue({ type: 'text', content: 'Explained why impossible.' });

      await runtime.run('impossible goal');

      expect(modules.runFinalizer.finalizeRun).toHaveBeenCalledWith(
        expect.any(Number),
        'impossible goal',
        expect.anything(),
        expect.any(Number),
        expect.objectContaining({ status: 'aborted' }),
      );
    });

    it('continues goal mode after a plain text response and lets the fallback gate stop it', async () => {
      ctx.goalMode = new GoalModeController({
        goal: 'finish',
        verifyCommand: 'true',
        tokenBudget: 100_000,
        maxTurns: 2,
      });
      modules.contextAssembly.inference.mockResolvedValue({
        type: 'text',
        content: 'I am not done yet.',
        usage: { inputTokens: 120, outputTokens: 7 },
      });

      await runtime.run('finish');

      expect(modules.contextAssembly.inference).toHaveBeenCalledTimes(1);
      expect(modules.contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
        expect.stringContaining('<goal-continuation>'),
      );
      expect(ctx.onEvent).toHaveBeenCalledWith({
        type: 'goal_complete',
        data: expect.objectContaining({
          status: 'aborted',
          reason: expect.stringContaining('达到轮次上限 2'),
          turns: 2,
        }),
      });
      expect(modules.runFinalizer.finalizeRun).toHaveBeenCalledWith(
        expect.any(Number),
        'finish',
        expect.anything(),
        expect.any(Number),
        expect.objectContaining({ status: 'aborted' }),
      );
    });

    it('keeps truncation continuation advisory at loop-decision level', async () => {
      activityMocks.formatActivityPromptContext.mockReturnValueOnce({ mode: 'none' });
      modules.contextAssembly.inference.mockResolvedValue({
        type: 'text',
        content: 'Truncated answer',
        finishReason: 'max_tokens',
      });

      await runtime.run('continue after truncation');

      expect(modules.contextAssembly.injectSystemMessage).not.toHaveBeenCalledWith(
        'Continue from where you stopped. Do not restate or apologize.',
      );
    });

    it('keeps compact loop decisions advisory under context pressure', async () => {
      activityMocks.formatActivityPromptContext.mockReturnValueOnce({ mode: 'none' });
      ctx.totalInputTokens = 120_000;
      modules.contextAssembly.inference.mockResolvedValue({
        type: 'text',
        content: 'Done!',
        finishReason: 'end_turn',
      });

      await runtime.run('context pressure');

      expect(modules.contextAssembly.checkAndAutoCompress).not.toHaveBeenCalled();
      expect(modules.contextAssembly.injectSystemMessage).not.toHaveBeenCalledWith(
        'Continue from where you stopped. Do not restate or apologize.',
      );
    });

    it('keeps terminate loop decisions advisory when the response otherwise completes', async () => {
      activityMocks.formatActivityPromptContext.mockReturnValueOnce({ mode: 'none' });
      ctx.consecutiveErrors = 3;
      modules.contextAssembly.inference.mockResolvedValue({
        type: 'text',
        content: 'Recovered response',
        finishReason: 'end_turn',
      });

      await runtime.run('terminate advisory');

      expect(modules.runFinalizer.finalizeRun).toHaveBeenCalledWith(
        expect.any(Number),
        'terminate advisory',
        expect.anything(),
        expect.any(Number),
        expect.objectContaining({ status: 'completed' }),
      );
    });

    it('should stop on cancel during loop', async () => {
      ctx.isCancelled = true;
      await runtime.run('test');
      // Should not call inference because isCancelled is true from the start
      // (initializeRun runs, but the while loop exits immediately)
      expect(modules.runFinalizer.finalizeRun).toHaveBeenCalled();
    });

    it('should stop when circuit breaker is tripped', async () => {
      (ctx.circuitBreaker.isTripped as any).mockReturnValue(true);
      await runtime.run('test');
      expect(modules.runFinalizer.finalizeRun).toHaveBeenCalled();
    });

    it('keeps pause in waiting state without finalizing until resume', async () => {
      runtime.pause();

      let settled = false;
      const runPromise = runtime.run('pause test').then(() => {
        settled = true;
      });

      await new Promise(resolve => setTimeout(resolve, 20));

      expect(settled).toBe(false);
      expect(modules.contextAssembly.inference).not.toHaveBeenCalled();
      expect(modules.runFinalizer.finalizeRun).not.toHaveBeenCalled();

      runtime.resume();
      await runPromise;

      expect(modules.contextAssembly.inference).toHaveBeenCalled();
      expect(modules.runFinalizer.finalizeRun).toHaveBeenCalledWith(
        expect.any(Number),
        'pause test',
        expect.anything(),
        expect.any(Number),
        expect.objectContaining({ status: 'completed' }),
      );
    });

    it('finalizes as failed and rethrows when inference throws', async () => {
      const error = new Error('model exploded');
      modules.contextAssembly.inference.mockRejectedValueOnce(error);

      await expect(runtime.run('boom')).rejects.toThrow('model exploded');

      expect(modules.runFinalizer.finalizeRun).toHaveBeenCalledWith(
        expect.any(Number),
        'boom',
        expect.anything(),
        expect.any(Number),
        expect.objectContaining({ status: 'failed', error }),
      );
      expect(modules.contextAssembly.addAndPersistMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'system',
          isMeta: true,
          source: 'system',
          content: expect.stringContaining('失败轮用户请求：boom'),
        }),
      );
      expect(modules.contextAssembly.addAndPersistMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('失败错误：model exploded'),
        }),
      );
      expect(ctx.runAbortController).toBeNull();
    });
  });
});
