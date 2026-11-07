// ============================================================================
// N-CAP-NOTICE-LEAK：turnSystemContext 脚手架（含 <repeated_workarounds> 候选能力块）
// 与「分析类消费者」的边界回归。
// ============================================================================
// 真机实录（realrun20 07/08）：首轮注入的 <repeated_workarounds> 块跟着整条
// wrapWithTurnSystemContext 包装体流进了 judge / goalTracker 等分析入口——
// 小模型把注入块当任务复述，`Judgment fallback used: No JSON found in response`；
// 注入块里的 `- 名字：已拼凑 N 次` 列表行还被 parseMultiStepTask 认成步骤，
// 整轮被劫持进 step-by-step 模式。
//
// 这里的钉子：**模型面消息保持包装**（模型需要看到注入块），但所有「读用户想干
// 什么」的分析消费者必须只拿到 <user_request> 里的用户原话（extractUserRequest）。
// 复用的是 conversationRuntime.test.ts 的装配 harness，仅替换 fixture 与断言。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import { wrapWithTurnSystemContext } from '../../../src/shared/utils/turnScaffold';

const activityMocks = vi.hoisted(() => ({
  getCurrentActivityContext: vi.fn(),
  formatActivityPromptContext: vi.fn(),
}));

const judgeMocks = vi.hoisted(() => ({
  judge: vi.fn().mockResolvedValue({ shouldParallel: false, confidence: 0.5 }),
}));

const workspaceSearchMocks = vi.hoisted(() => ({
  buildWorkspaceActivityContextBlock: vi.fn().mockResolvedValue(null),
}));

const recoveredWorkMocks = vi.hoisted(() => ({
  buildRecoveredWorkOrchestrationHint: vi.fn().mockResolvedValue(null),
  isContinuationLikeRequest: vi.fn().mockReturnValue(false),
}));

const seedMemoryMocks = vi.hoisted(() => ({
  buildPackedSeedMemory: vi.fn().mockResolvedValue(null),
  buildPackedUserDirectives: vi.fn().mockResolvedValue(null),
}));

const dynamicPromptMocks = vi.hoisted(() => ({
  buildDynamicPromptV2: vi.fn().mockReturnValue({
    mode: 'code',
    features: {},
    modeConfig: { readOnly: false },
    reminderStats: { deduplication: { selected: 0 } },
    tokensUsed: 0,
    userMessage: 'test message',
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../src/host/mcp/logCollector', () => ({
  logCollector: { agent: vi.fn(), addLog: vi.fn() },
}));

vi.mock('../../../src/host/agent/runtime/turnSnapshotWriter', () => ({
  writeTurnSnapshot: vi.fn(),
}));

vi.mock('../../../src/host/services/planning/taskStore', () => ({
  getIncompleteTasks: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/host/memory/sanitizeMemoryContent', () => ({
  sanitizeMemoryContent: vi.fn().mockReturnValue('sanitized'),
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

// 复杂度按 complex 走：让 judge / 动态模式 / desktop bootstrap 这些非 simple 分支真的执行
vi.mock('../../../src/host/planning/taskComplexityAnalyzer', () => ({
  taskComplexityAnalyzer: {
    analyze: vi.fn().mockReturnValue({
      complexity: 'complex',
      confidence: 0.9,
      reasons: [],
      targetFiles: [],
    }),
    generateComplexityHint: vi.fn().mockReturnValue(''),
  },
}));

vi.mock('../../../src/host/planning/taskOrchestrator', () => ({
  getTaskOrchestrator: () => ({
    judge: judgeMocks.judge,
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
  buildPackedSeedMemory: seedMemoryMocks.buildPackedSeedMemory,
  buildPackedUserDirectives: seedMemoryMocks.buildPackedUserDirectives,
  buildSeedMemoryBlock: vi.fn().mockReturnValue(null),
}));

vi.mock('../../../src/host/services/activity/activityContextProvider', () => ({
  getCurrentActivityContext: activityMocks.getCurrentActivityContext,
}));

vi.mock('../../../src/host/services/activity/activityPromptFormatter', () => ({
  formatActivityPromptContext: activityMocks.formatActivityPromptContext,
}));

// 注意路径：desktop 派生上下文的服务真身都在 src/host/desktop/ 下
// （conversationRuntime.test.ts 里 memory/ 的两个 mock 是不存在的模块路径，等价没 mock）。
vi.mock('../../../src/host/desktop/desktopActivityUnderstandingService', () => ({
  getDesktopActivityUnderstandingService: () => ({
    ensureFreshData: vi.fn(),
    listTodoItems: vi.fn().mockReturnValue([]),
    listTodoCandidates: vi.fn().mockReturnValue([]),
    syncTodoCandidatesToTasks: vi.fn().mockReturnValue({ created: [], tasks: [], totalCandidates: 0 }),
    buildContextBlock: vi.fn().mockReturnValue(null),
  }),
}));

vi.mock('../../../src/host/desktop/desktopActivityPlanningBridge', () => ({
  syncDesktopTasksToPlanningService: vi.fn().mockResolvedValue({
    createdPlan: false,
    createdPhase: false,
    addedSteps: [],
    updatedSteps: [],
  }),
}));

vi.mock('../../../src/host/desktop/workspaceActivitySearchService', () => ({
  buildWorkspaceActivityContextBlock: workspaceSearchMocks.buildWorkspaceActivityContextBlock,
}));

vi.mock('../../../src/host/planning/recoveredWorkOrchestrator', () => ({
  buildRecoveredWorkOrchestrationHint: recoveredWorkMocks.buildRecoveredWorkOrchestrationHint,
  isContinuationLikeRequest: recoveredWorkMocks.isContinuationLikeRequest,
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
  syncTodosToSessionTasks: vi.fn().mockReturnValue({ tasks: [] }),
}));

vi.mock('../../../src/host/lightMemory/sessionMetadata', () => ({
  recordSessionStart: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/host/lightMemory/recentConversations', () => ({
  buildRecentConversationsBlock: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../src/host/prompts/builder', () => ({
  getPromptForTask: vi.fn().mockReturnValue(''),
  buildDynamicPromptV2: dynamicPromptMocks.buildDynamicPromptV2,
}));

vi.mock('../../../src/host/context/tokenOptimizer', () => ({
  compressToolResult: vi.fn().mockReturnValue('compressed'),
  HookMessageBuffer: class { append() {} flush() { return []; } },
  estimateModelMessageTokens: vi.fn().mockReturnValue(100),
  MessageHistoryCompressor: class { compress() {} },
  estimateTokens: vi.fn().mockReturnValue(100),
}));

vi.mock('../../../src/host/agent/structuredOutput', () => ({
  generateFormatCorrectionPrompt: vi.fn().mockReturnValue('correction prompt'),
}));

vi.mock('../../../src/host/agent/runtime/messageProcessor', () => ({
  MessageProcessor: class MockMessageProcessor {
    handleTextResponse = vi.fn().mockResolvedValue('break');
    handleToolResponse = vi.fn().mockResolvedValue('continue');
    detectAndForceExecuteTextToolCall = vi.fn().mockReturnValue({ shouldContinue: false, response: { type: 'text', content: 'done' }, wasForceExecuted: false });
    recordModelCallTelemetry = vi.fn();
    injectSteerMessage = vi.fn();
    generateTruncationWarning = vi.fn().mockReturnValue('Warning');
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
  WRITE_TOOLS: [],
}));

vi.mock('../../../src/host/agent/toolExecution/parallelStrategy', () => ({
  isParallelSafeTool: vi.fn(),
  classifyToolCalls: vi.fn(),
  executeOrderedSegments: vi.fn(),
  toolBatchLabel: (name: string) => name,
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
  retainSkillInvocationForTurn: vi.fn((invocation: unknown) => invocation),
}));

const jevWardenMocks = vi.hoisted(() => {
  const warden = { reviewToolStep: vi.fn(), interceptFinal: vi.fn() };
  return { warden, createJevWarden: vi.fn(() => warden) };
});
vi.mock('../../../src/host/agent/runtime/jevWarden', () => ({
  createJevWarden: jevWardenMocks.createJevWarden,
}));

vi.mock('../../../src/host/agent/capabilityGapTurnRecorder', () => ({
  recordCapabilityGapTurn: vi.fn(async () => undefined),
}));

vi.mock('../../../src/host/services/skills/comboRecorder', () => ({
  getComboRecorder: () => ({ startRecording: vi.fn(), markTurn: vi.fn() }),
}));

vi.mock('../../../src/host/context/autoCompressor', () => ({
  getAutoCompressor: vi.fn(() => ({})),
}));

vi.mock('../../../src/host/telemetry/telemetryAdapter', () => ({
  createTelemetryAdapter: vi.fn(() => ({})),
}));

vi.mock('../../../src/host/agent/metricsCollector', () => ({
  composeTelemetryAdapters: vi.fn((adapter: unknown) => adapter),
}));

import { ConversationRuntime } from '../../../src/host/agent/runtime/conversationRuntime';

// --------------------------------------------------------------------------
// Fixture — 首轮真实形状：候选能力块 + <user_request> 包装
// --------------------------------------------------------------------------

const USER_REQUEST = '请分析这个 sales.csv：按地区汇总金额，告诉我哪个地区最高。';

/** 与 buildCapabilityCandidateNotice 的真实输出同形（含候选列表行） */
const CAPABILITY_NOTICE_BLOCK = [
  '<repeated_workarounds>',
  '以下是你在过去的会话里反复用现成工具拼凑完成的事情（次数为真实统计）：',
  '- 截图转表格：已拼凑 2 次，平均 3 步。',
  '- 网页存档：已拼凑 2 次，平均 4 步。',
  '用户如果问起「你还能加什么能力」「这事是不是老做」，可以据此如实回答。',
  '除此之外不要主动提起，更不要建议用户去做成新能力——本期不接受推销。',
  '</repeated_workarounds>',
].join('\n');

function firstTurnWrappedMessage(): string {
  return wrapWithTurnSystemContext([CAPABILITY_NOTICE_BLOCK], USER_REQUEST);
}

// --------------------------------------------------------------------------
// Harness（与 conversationRuntime.test.ts 同构的最小 RuntimeContext）
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
    sessionId: 'test-session-notice-leak',
    userId: 'test-user',
    circuitBreaker: { isTripped: vi.fn().mockReturnValue(false), recordSuccess: vi.fn(), recordFailure: vi.fn(), reset: vi.fn() } as any,
    antiPatternDetector: { detect: vi.fn().mockReturnValue([]), reset: vi.fn() } as any,
    goalTracker: {
      initialize: vi.fn(),
      shouldInject: vi.fn().mockReturnValue(false),
      buildInjection: vi.fn().mockReturnValue(''),
      recordAction: vi.fn(),
      getGoal: vi.fn().mockReturnValue(''),
    } as any,
    nudgeManager: { check: vi.fn().mockReturnValue(null) } as any,
    hookMessageBuffer: { append: vi.fn(), flush: vi.fn().mockReturnValue([]) } as any,
    messageHistoryCompressor: { compress: vi.fn() } as any,
    autoCompressor: { compress: vi.fn() } as any,
    control: ControlState.forTest(),
    contextHealth: ContextHealthState.forTest(),
    autoApprovePlan: false,
    enableHooks: false,
    maxStopHookRetries: 3,
    maxToolCallRetries: 3,
    enableToolDeferredLoading: false,
    maxStructuredOutputRetries: 3,
    stepByStepMode: false,
    turnTrace: { setTurn: () => {}, record: () => {}, flush: () => {}, getEvents: () => [] } as any,
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
    toolEngine: { resetRepairGate: vi.fn(), consecutiveErrors: 0, executeToolCalls: vi.fn(), executeSingleTool: vi.fn() } as any,
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
    learningPipeline: { learn: vi.fn() } as any,
  };
}

function createRuntime(overrides: Partial<RuntimeContext> = {}) {
  const ctx = createMockContext(overrides);
  const runtime = new ConversationRuntime(ctx);
  const modules = createMockModules();
  runtime.setModules(modules.toolEngine, modules.contextAssembly, modules.runFinalizer, modules.learningPipeline);
  jevWardenMocks.warden.reviewToolStep.mockResolvedValue({ kind: 'none' });
  jevWardenMocks.warden.interceptFinal.mockReturnValue(null);
  return { ctx: ctx as Mutable<RuntimeContext>, runtime, modules };
}

beforeEach(() => {
  vi.clearAllMocks();
  judgeMocks.judge.mockClear().mockResolvedValue({ shouldParallel: false, confidence: 0.5 });
  workspaceSearchMocks.buildWorkspaceActivityContextBlock.mockClear().mockResolvedValue(null);
  seedMemoryMocks.buildPackedSeedMemory.mockClear().mockResolvedValue(null);
  seedMemoryMocks.buildPackedUserDirectives.mockClear().mockResolvedValue(null);
  dynamicPromptMocks.buildDynamicPromptV2.mockClear().mockReturnValue({
    mode: 'code',
    features: {},
    modeConfig: { readOnly: false },
    reminderStats: { deduplication: { selected: 0 } },
    tokensUsed: 0,
    userMessage: 'test message',
  });
  activityMocks.getCurrentActivityContext.mockResolvedValue({
    generatedAtMs: 1_800_000,
    maxChars: 1_000,
    tokenBudgetHint: { maxChars: 1_000, targetTokens: 250 },
    sources: [],
    evidenceRefs: [],
  });
  activityMocks.formatActivityPromptContext.mockReturnValue({ mode: 'none' });
});

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('首轮 <repeated_workarounds> 脚手架与分析类消费者的边界', () => {
  it('judge 只拿用户原话：小模型的任务文本里不得出现注入块（N-CAP-NOTICE-LEAK 真机泄漏点）', async () => {
    const { runtime } = createRuntime();
    await runtime.initializeRun(firstTurnWrappedMessage());

    expect(judgeMocks.judge).toHaveBeenCalledTimes(1);
    expect(judgeMocks.judge).toHaveBeenCalledWith(USER_REQUEST);
  });

  it('goalTracker.initialize 只拿用户原话：注入块首行不得成为被周期重注入的「目标」', async () => {
    const { ctx, runtime } = createRuntime();
    await runtime.initializeRun(firstTurnWrappedMessage());

    expect(ctx.goalTracker.initialize).toHaveBeenCalledWith(USER_REQUEST);
  });

  it('buildDynamicPromptV2 只拿用户原话做任务特征/模式判定', async () => {
    const { runtime } = createRuntime();
    await runtime.initializeRun(firstTurnWrappedMessage());

    expect(dynamicPromptMocks.buildDynamicPromptV2).toHaveBeenCalled();
    const firstArg = dynamicPromptMocks.buildDynamicPromptV2.mock.calls[0][0] as string;
    expect(firstArg).toBe(USER_REQUEST);
  });

  it('parseMultiStepTask 不把注入块的候选列表行认成步骤：step-by-step 模式不被劫持', async () => {
    // stepByStepMode 开 + 注入块里恰好有 ≥2 条 `- xxx：已拼凑 N 次` 列表行：
    // 修复前这些行匹配步骤正则，isMultiStep=true，整轮被劫持进 runStepByStep
    // （initializeRun 提前返回 null；真机上还会经 run→initializeRun 无限递归直到
    // 资源耗尽）。这里把 runStepByStep mock 掉以防递归，只钉「劫持是否发生」。
    // 修复后按用户原话解析——原话没有列表行，正常进入主循环。
    const { runtime } = createRuntime({ stepByStepMode: true });
    const stepsSpy = vi
      .spyOn(runtime as unknown as { runStepByStep: (message: string, steps: string[]) => Promise<boolean> }, 'runStepByStep')
      .mockResolvedValue(true);
    const result = await runtime.initializeRun(firstTurnWrappedMessage());

    expect(result).not.toBeNull();
    expect(stepsSpy).not.toHaveBeenCalled();
  });

  it('desktop 工作区相关性评分只拿用户原话', async () => {
    const { runtime } = createRuntime();
    await runtime.initializeRun(firstTurnWrappedMessage());

    expect(workspaceSearchMocks.buildWorkspaceActivityContextBlock).toHaveBeenCalled();
    expect(workspaceSearchMocks.buildWorkspaceActivityContextBlock.mock.calls[0][0]).toBe(USER_REQUEST);
  });

  it('seed memory 检索 query 只拿用户原话', async () => {
    const { runtime } = createRuntime();
    await runtime.initializeRun(firstTurnWrappedMessage());

    expect(seedMemoryMocks.buildPackedSeedMemory).toHaveBeenCalled();
    const query = seedMemoryMocks.buildPackedSeedMemory.mock.calls[0][0]?.query as unknown;
    expect(query).toBe(USER_REQUEST);
  });

  it('对照：无脚手架的裸消息行为不变（judge/goalTracker 收到的就是原话）', async () => {
    const { ctx, runtime } = createRuntime();
    await runtime.initializeRun(USER_REQUEST);

    expect(judgeMocks.judge).toHaveBeenCalledWith(USER_REQUEST);
    expect(ctx.goalTracker.initialize).toHaveBeenCalledWith(USER_REQUEST);
  });
});

