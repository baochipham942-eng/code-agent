// ============================================================================
// ConversationRuntime Tests
// Tests for session initialization, message handling, state transitions,
// control methods (cancel/interrupt/steer), plan mode, structured output
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --------------------------------------------------------------------------
// Mocks — must be declared before imports
// --------------------------------------------------------------------------

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
  },
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

vi.mock('../../../src/main/planning/taskComplexityAnalyzer', () => ({
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

vi.mock('../../../src/main/routing/intentClassifier', () => ({
  classifyIntent: vi.fn().mockResolvedValue('general'),
}));

vi.mock('../../../src/main/planning/taskOrchestrator', () => ({
  getTaskOrchestrator: () => ({
    judge: vi.fn().mockResolvedValue({ shouldParallel: false, confidence: 0.5 }),
    generateParallelHint: vi.fn().mockReturnValue(''),
  }),
}));

vi.mock('../../../src/main/services/cloud/featureFlagService', () => ({
  getMaxIterations: vi.fn().mockReturnValue(25),
}));

vi.mock('../../../src/main/hooks', () => ({
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

vi.mock('../../../src/main/agent/sessionRecovery', () => ({
  getSessionRecoveryService: () => ({
    checkPreviousSession: vi.fn().mockResolvedValue(null),
    saveSessionState: vi.fn(),
  }),
}));

vi.mock('../../../src/main/memory/seedMemoryInjector', () => ({
  buildSeedMemoryBlock: vi.fn().mockReturnValue(null),
}));

vi.mock('../../../src/main/memory/desktopActivityUnderstandingService', () => ({
  getDesktopActivityUnderstandingService: () => ({
    ensureFreshData: vi.fn(),
    listTodoItems: vi.fn().mockReturnValue([]),
    syncTodoCandidatesToTasks: vi.fn().mockReturnValue({ created: [], updated: [], tasks: [], totalCandidates: 0 }),
    buildContextBlock: vi.fn().mockReturnValue(null),
  }),
}));

vi.mock('../../../src/main/memory/desktopActivityPlanningBridge', () => ({
  syncDesktopTasksToPlanningService: vi.fn().mockResolvedValue({
    createdPlan: false,
    createdPhase: false,
    addedSteps: [],
    updatedSteps: [],
  }),
}));

vi.mock('../../../src/main/memory/workspaceActivitySearchService', () => ({
  buildWorkspaceActivityContextBlock: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../src/main/planning/recoveredWorkOrchestrator', () => ({
  buildRecoveredWorkOrchestrationHint: vi.fn().mockResolvedValue(null),
  isContinuationLikeRequest: vi.fn().mockReturnValue(false),
  recoverRecentWorkIntoPlanning: vi.fn().mockResolvedValue({ planChanged: false, planningSync: { addedSteps: [] } }),
}));

vi.mock('../../../src/main/planning', () => ({
  publishPlanningStateToRenderer: vi.fn(),
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

vi.mock('../../../src/main/lightMemory/sessionMetadata', () => ({
  recordSessionStart: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/main/prompts/builder', () => ({
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

vi.mock('../../../src/main/agent/structuredOutput', () => ({
  generateFormatCorrectionPrompt: vi.fn().mockReturnValue('correction prompt'),
}));

vi.mock('../../../src/main/services/planning/taskStore', () => ({
  getIncompleteTasks: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/main/context/tokenOptimizer', () => ({
  compressToolResult: vi.fn().mockReturnValue('compressed'),
  HookMessageBuffer: class { append() {} flush() { return []; } },
  estimateModelMessageTokens: vi.fn().mockReturnValue(100),
  MessageHistoryCompressor: class { compress() {} },
  estimateTokens: vi.fn().mockReturnValue(100),
}));

vi.mock('../../../src/main/context/autoCompressor', () => ({
  AutoContextCompressor: class { compress() {} },
  getAutoCompressor: vi.fn(),
}));

vi.mock('../../../src/main/memory/sanitizeMemoryContent', () => ({
  sanitizeMemoryContent: vi.fn().mockReturnValue('sanitized'),
}));

vi.mock('../../../src/main/agent/runtime/messageProcessor', () => ({
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

vi.mock('../../../src/main/agent/runtime/streamHandler', () => ({
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
  TOOL_PROGRESS: {},
  TOOL_TIMEOUT_THRESHOLDS: {},
}));

vi.mock('../../../src/main/model/modelRouter', () => ({
  ModelRouter: class {},
  ContextLengthExceededError: class extends Error {},
}));

vi.mock('../../../src/main/context/contextHealthService', () => ({
  getContextHealthService: vi.fn(),
}));

vi.mock('../../../src/main/telemetry/systemPromptCache', () => ({
  getSystemPromptCache: vi.fn(),
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

vi.mock('../../../src/main/tools/fileReadTracker', () => ({
  fileReadTracker: { getRecentFiles: vi.fn().mockReturnValue([]) },
}));

vi.mock('../../../src/main/tools/dataFingerprint', () => ({
  dataFingerprintStore: {},
}));

vi.mock('../../../src/main/agent/loopTypes', () => ({
  MAX_PARALLEL_TOOLS: 4,
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
    reset = vi.fn();
  },
}));

vi.mock('../../../src/main/tools/executionPhase', () => ({
  classifyExecutionPhase: vi.fn(),
}));

vi.mock('../../../src/main/agent/messageHandling/converter', () => ({
  formatToolCallForHistory: vi.fn(),
  sanitizeToolResultsForHistory: vi.fn(),
  buildMultimodalContent: vi.fn(),
  stripImagesFromMessages: vi.fn(),
  extractUserRequestText: vi.fn(),
}));

vi.mock('../../../src/main/agent/messageHandling/contextBuilder', () => ({
  injectWorkingDirectoryContext: vi.fn(),
  buildEnhancedSystemPrompt: vi.fn().mockReturnValue('system prompt'),
  buildRuntimeModeBlock: vi.fn().mockReturnValue(''),
}));

vi.mock('../../../src/main/agent/antiPattern/detector', () => ({
  AntiPatternDetector: class {
    detect = vi.fn().mockReturnValue([]);
    reset = vi.fn();
  },
}));

vi.mock('../../../src/main/agent/antiPattern/cleanXml', () => ({
  cleanXmlResidues: vi.fn().mockReturnValue(''),
}));

vi.mock('../../../src/main/agent/goalTracker', () => ({
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

vi.mock('../../../src/main/memory/continuousLearningService', () => ({
  getContinuousLearningService: vi.fn(),
}));

vi.mock('../../../src/main/services/toolSearch', () => ({
  getToolSearchService: vi.fn(),
}));

// --------------------------------------------------------------------------
// Import after mocks
// --------------------------------------------------------------------------

import { ConversationRuntime } from '../../../src/main/agent/runtime/conversationRuntime';
import type { RuntimeContext } from '../../../src/main/agent/runtime/runtimeContext';

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
    _isRunning: false,
    isInterrupted: false,
    interruptMessage: null,
    needsReinference: false,
    abortController: null,

    isPlanModeActive: false,
    planModeActive: false,
    savedMessages: null,
    currentAgentMode: 'code',
    autoApprovePlan: false,

    enableHooks: false,
    userHooksInitialized: false,
    stopHookRetryCount: 0,
    maxStopHookRetries: 3,

    toolCallRetryCount: 0,
    maxToolCallRetries: 3,
    externalDataCallCount: 0,
    preApprovedTools: new Set(),
    enableToolDeferredLoading: false,

    structuredOutputRetryCount: 0,
    maxStructuredOutputRetries: 3,

    stepByStepMode: false,

    traceId: '',
    currentIterationSpanId: '',
    currentTurnId: '',

    turnStartTime: 0,
    toolsUsedInTurn: [],
    isSimpleTaskMode: true,

    _researchModeActive: false,
    _researchIterationCount: 0,
    researchModeInjected: false,

    budgetWarningEmitted: false,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    consecutiveErrors: 0,

    effortLevel: 'normal' as any,
    thinkingStepCount: 0,

    runStartTime: 0,
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
    autoCompressThreshold: 0.85,
    contextBudgetRatio: 0,
    genNum: 8,
    initialSystemPromptLength: 0,

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
    } as any,
    runFinalizer: {
      finalizeRun: vi.fn(),
      checkAndEmitBudgetStatus: vi.fn().mockReturnValue(false),
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
    it('generateTruncationWarning should delegate to messageProcessor', () => {
      const warning = runtime.generateTruncationWarning();
      expect(warning).toBe('Warning: context truncated');
    });

    it('generateAutoContinuationPrompt should delegate to messageProcessor', () => {
      const prompt = runtime.generateAutoContinuationPrompt();
      expect(prompt).toBe('Continue...');
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
      await runtime.initializeUserHooks();
      expect(ctx.userHooksInitialized).toBe(true);
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
  });
});
