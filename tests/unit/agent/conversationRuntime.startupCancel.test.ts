
// ============================================================================
// ConversationRuntime 启动装配期取消（N-STOP-DURING-STARTUP）
// ============================================================================
// 回归背景：真机槽 3 上崩溃后续跑刚启动时点「停止」，要等 HookManager/技能发现/
// AGENTS.md/近期会话/seed memory/桌面活动理解全部装配完（8~22s）主循环才看到 abort。
// 修复后 initializeRun 在每个慢步骤与 run 级 abort 信号竞速、每个 await 边界检查
// 取消，取消即刻退出装配并由 run() 走既有 cancelled 收尾（finalizeRun → agent_cancelled
// → 编排侧 user_stop 停靠）。这里钉住三件事：慢步骤中途取消 → 慢步骤完成前退出、
// 装配后半段（记忆注入）不再跑、终态走现有 cancelled 语义。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';

// --------------------------------------------------------------------------
// Mocks — 与 conversationRuntime.test.ts 同一套夹具（该文件顶部有说明：mock 面必须
// 覆盖 initializeRun 的全部外部依赖，否则真实模块会拖进 DB/文件系统）。
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

vi.mock('../../../src/host/agent/runtime/turnSnapshotWriter', () => ({
  writeTurnSnapshot: vi.fn(),
}));

vi.mock('../../../src/host/services', () => ({
  getConfigService: () => ({ onSettingsUpdated: vi.fn(), getApiKey: vi.fn().mockReturnValue('mock-key') }),
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
  buildPackedUserDirectives: vi.fn().mockResolvedValue(null),
  buildSeedMemoryBlock: vi.fn().mockReturnValue(null),
}));

vi.mock('../../../src/host/services/activity/activityContextProvider', () => ({
  getCurrentActivityContext: vi.fn().mockResolvedValue({
    generatedAtMs: 1_800_000,
    maxChars: 1_000,
    tokenBudgetHint: { maxChars: 1_000, targetTokens: 250 },
    sources: [],
    evidenceRefs: [],
  }),
}));

vi.mock('../../../src/host/services/activity/activityPromptFormatter', () => ({
  formatActivityPromptContext: vi.fn().mockReturnValue({
    mode: 'legacySeparate',
    screenMemoryBlock: 'screen context from activity provider',
    desktopActivityBlock: 'desktop context from activity provider',
  }),
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

vi.mock('../../../src/host/lightMemory/recentConversations', () => ({
  buildRecentConversationsBlock: vi.fn().mockResolvedValue(null),
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

vi.mock('../../../src/shared/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/shared/constants')>()),
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
    ANTI_SPIN_THRESHOLD: 3,
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

vi.mock('../../../src/host/services/citation/citationService', () => ({
  getCitationService: vi.fn(),
}));

vi.mock('../../../src/host/tools/fileReadTracker', () => ({
  fileReadTracker: { clear: vi.fn(), forgetShownRanges: vi.fn(), getRecentFiles: vi.fn().mockReturnValue([]) },
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
import { buildPackedSeedMemory } from '../../../src/host/utils/seedMemoryInjector';
import { buildRecentConversationsBlock } from '../../../src/host/lightMemory/recentConversations';
import { resolveSkillInvocation } from '../../../src/host/services/skills/skillInvocationResolver';
import { clearMemoryInjectionTracesForTest } from '../../../src/host/memory/memoryInjectionTrace';

// --------------------------------------------------------------------------
// Helper — 与 conversationRuntime.test.ts 同一套最小 RuntimeContext 夹具
// --------------------------------------------------------------------------

type Mutable<T> = { -readonly [P in keyof T]: T[P] };

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

    control: ControlState.forTest(),

    autoApprovePlan: false,

    enableHooks: false,
    maxStopHookRetries: 3,

    maxToolCallRetries: 3,
    enableToolDeferredLoading: false,

    maxStructuredOutputRetries: 3,

    stepByStepMode: false,

    turnTrace: {
      setTurn: () => {},
      record: () => {},
      flush: () => {},
      getEvents: () => [],
    } as any,
    turnQualityState: {},
    goalEvidenceState: { bounces: 0 },
    turn: TurnState.forTest({ isSimpleTaskMode: true, effortLevel: 'normal' as never }),

    consecutiveErrors: 0,

    artifact: ArtifactState.forTest(),

    stats: RunStatsState.forTest({ pendingRuntimeDiagnostics: [], totalInputTokens: 0, totalOutputTokens: 0, runStartTime: 0, totalTokensUsed: 0, totalToolCallCount: 0 } as never),

    MAX_CONSECUTIVE_TRUNCATIONS: 3,

    persistentSystemContext: [],

    ...overrides,
  } as RuntimeContext;
}

function createMockModules() {
  return {
    toolEngine: {
      resetRepairGate: vi.fn(),
      consecutiveErrors: 0,
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
      generateId: vi.fn().mockReturnValue('generated-msg-id'),
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

describe('ConversationRuntime startup assembly cancellation', () => {
  let ctx: Mutable<RuntimeContext>;
  let runtime: ConversationRuntime;
  let modules: ReturnType<typeof createMockModules>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearMemoryInjectionTracesForTest();
    vi.mocked(buildPackedSeedMemory).mockResolvedValue(null);
    vi.mocked(buildRecentConversationsBlock).mockResolvedValue(null);
    ctx = createMockContext();
    runtime = new ConversationRuntime(ctx);
    modules = createMockModules();
    runtime.setModules(modules.toolEngine, modules.contextAssembly, modules.runFinalizer, modules.learningPipeline);
  });

  it('exits the run before a slow assembly step completes when cancelled mid-step', async () => {
    // 慢步骤：技能发现 8s 后才完成（模拟真机 ~3s 的 SkillDiscoveryService +
    // 记忆/桌面理解等秒级装配步骤）。取消发生在步骤进行中。
    let slowStepCompleted = false;
    vi.mocked(resolveSkillInvocation).mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => {
        slowStepCompleted = true;
        resolve(null);
      }, 8_000);
    }));

    const runPromise = runtime.run('startup cancel probe');
    await vi.waitFor(() => {
      expect(resolveSkillInvocation).toHaveBeenCalled();
    });

    const cancelAt = Date.now();
    await runtime.cancel('user');
    await runPromise;

    // 慢步骤被放弃：run 在其完成前（且远小于 2s 验收线）退出
    expect(slowStepCompleted).toBe(false);
    expect(Date.now() - cancelAt).toBeLessThan(2_000);

    // 走既有取消收尾：finalizeRun 收到 cancelled 终态（agent_cancelled 事件由此发出，
    // 编排侧据此 user_stop 停靠）
    expect(modules.runFinalizer.finalizeRun).toHaveBeenCalledWith(
      0,
      'startup cancel probe',
      expect.anything(),
      expect.anything(),
      { status: 'cancelled' },
    );
    expect(ctx.control.isCancelled).toBe(true);
    expect(ctx.control.isSettled).toBe(true);

    // 取消后装配后半段不得再跑（seed memory / 近期会话注入）
    expect(buildPackedSeedMemory).not.toHaveBeenCalled();
    expect(buildRecentConversationsBlock).not.toHaveBeenCalled();
  });

  it('parks the run as cancelled when cancel lands before assembly starts', async () => {
    await runtime.cancel('user');

    await runtime.run('early cancel');

    expect(modules.runFinalizer.finalizeRun).toHaveBeenCalledWith(
      0,
      'early cancel',
      expect.anything(),
      expect.anything(),
      { status: 'cancelled' },
    );
    expect(resolveSkillInvocation).not.toHaveBeenCalled();
    expect(buildPackedSeedMemory).not.toHaveBeenCalled();
  });

  it('still completes assembly and returns the init result when not cancelled', async () => {
    const result = await runtime.initializeRun('plain task');

    // 非取消路径零回归：装配照常完成，返回结构不变
    expect(result).toMatchObject({ isSimpleTask: true, genNum: 8 });
    expect(buildPackedSeedMemory).toHaveBeenCalled();
    expect(buildRecentConversationsBlock).toHaveBeenCalled();
  });
});
