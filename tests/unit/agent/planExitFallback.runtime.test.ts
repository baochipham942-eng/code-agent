// ============================================================================
// PlanExitFallback runtime 端到端（ADR-074 slice 1 / N-PLANEXIT-K1）
// 经 ConversationRuntime.run() 驱动：① 四类响应在真实循环里的落点、③ 幂等与
// 「补推理再交计划正文也按今日语义收尾」、④ 补推理中写类工具 admission 拒绝、
// ⑤ 非 plan mode 不受影响。harness 仿 conversationRuntime.test.ts。
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import type { ModelResponse } from '../../../src/host/agent/loopTypes';
import type { ToolResult } from '../../../src/shared/contract';

const activityMocks = vi.hoisted(() => ({
  getCurrentActivityContext: vi.fn(),
  formatActivityPromptContext: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/host/mcp/logCollector', () => ({
  logCollector: {
    agent: vi.fn(),
    tool: vi.fn(),
    addLog: vi.fn(),
    browser: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
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
    analyze: vi.fn().mockReturnValue({ complexity: 'simple', confidence: 0.8, reasons: [], targetFiles: [] }),
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
  getCurrentActivityContext: activityMocks.getCurrentActivityContext,
}));

vi.mock('../../../src/host/services/activity/activityPromptFormatter', () => ({
  formatActivityPromptContext: activityMocks.formatActivityPromptContext,
}));

vi.mock('../../../src/host/memory/desktopActivityUnderstandingService', () => ({
  getDesktopActivityUnderstandingService: () => ({
    ensureFreshData: vi.fn(),
    listTodoItems: vi.fn().mockReturnValue([]),
  }),
}));

vi.mock('../../../src/host/memory/continuousLearningService', () => ({
  getContinuousLearningService: vi.fn(),
}));

vi.mock('../../../src/host/services/toolSearch', () => ({
  getToolSearchService: () => ({ beginRound: vi.fn() }),
}));

vi.mock('../../../src/host/services/skills/skillInvocationResolver', () => ({
  resolveSkillInvocation: vi.fn().mockResolvedValue(null),
  buildSkillInvocationContext: vi.fn(),
}));

vi.mock('../../../src/host/lightMemory/recentConversations', () => ({
  buildRecentConversationsBlock: vi.fn().mockResolvedValue(null),
}));

import { ConversationRuntime } from '../../../src/host/agent/runtime/conversationRuntime';
import { MessageProcessor } from '../../../src/host/agent/runtime/messageProcessor';

const PLAN_BODY = ['我的方案：', '1. 梳理现有接口', '2. 抽出公共层', '3. 补齐用例'].join('\n');

function createMockContext(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    systemPrompt: 'You are an AI assistant.',
    modelConfig: { provider: 'zhipu', model: 'glm-5', maxTokens: 16384 },
    toolRegistry: { getTools: vi.fn().mockReturnValue([]), getTool: vi.fn() } as any,
    toolExecutor: { execute: vi.fn() } as any,
    messages: [],
    onEvent: vi.fn(),
    modelRouter: {} as any,
    maxIterations: 25,
    workingDirectory: '/tmp/planexit-k1-test',
    isDefaultWorkingDirectory: true,
    sessionId: 'planexit-session-1',
    userId: 'test-user',
    runId: 'run-e2e-1',
    circuitBreaker: {
      isTripped: vi.fn().mockReturnValue(false),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
      reset: vi.fn(),
    } as any,
    antiPatternDetector: { detect: vi.fn().mockReturnValue([]), reset: vi.fn(), detectFailedToolCallPattern: vi.fn().mockReturnValue(null) } as any,
    goalTracker: { initialize: vi.fn(), shouldInject: vi.fn().mockReturnValue(false), buildInjection: vi.fn().mockReturnValue(''), recordAction: vi.fn(), getGoal: vi.fn().mockReturnValue(''), getGoalCheckpoint: vi.fn().mockReturnValue(null) } as any,
    nudgeManager: {
      runNudgeChecks: vi.fn().mockReturnValue(false),
      runOutputValidation: vi.fn().mockReturnValue(false),
      getModifiedFiles: vi.fn().mockReturnValue(new Set<string>()),
      check: vi.fn().mockReturnValue(null),
    } as any,
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
      setTurn: vi.fn(),
      record: vi.fn(),
      flush: vi.fn(),
      getEvents: vi.fn().mockReturnValue([]),
    } as any,
    turnQualityState: {},
    goalEvidenceState: { bounces: 0 },
    turn: TurnState.forTest({
      isSimpleTaskMode: true,
      effortLevel: 'normal' as never,
      currentTurnId: 'turn-1',
      currentIterationSpanId: 'iteration-1',
      researchModeActive: false,
      toolsUsedInTurn: [],
    } as never),
    consecutiveErrors: 0,
    artifact: ArtifactState.forTest(),
    stats: RunStatsState.forTest({ pendingRuntimeDiagnostics: [], totalInputTokens: 0, totalOutputTokens: 0, runStartTime: 0, totalTokensUsed: 0, totalToolCallCount: 0 } as never),
    contextHealth: ContextHealthState.forTest({ currentSystemPromptHash: 'hash-1' } as never),
    MAX_CONSECUTIVE_TRUNCATIONS: 3,
    persistentSystemContext: [],
    telemetryAdapter: { onTurnStart: vi.fn(), onTurnEnd: vi.fn(), onModelCall: vi.fn() },
    ...overrides,
  } as RuntimeContext;
}

function createMockModules(ctx: RuntimeContext) {
  return {
    toolEngine: {
      resetRepairGate: vi.fn(),
      consecutiveErrors: 0,
      noProgressStopped: false,
      executeToolCalls: vi.fn(),
      executeSingleTool: vi.fn(),
      executeToolsWithHooks: vi.fn().mockResolvedValue([] as ToolResult[]),
      runtimeControl: { isPlanMode: () => false, setPlanMode: vi.fn() },
    } as any,
    contextAssembly: {
      inference: vi.fn().mockResolvedValue({ type: 'text', content: '占位' } as ModelResponse),
      injectSystemMessage: vi.fn<(content: string, source?: string) => void>(),
      injectResearchModePrompt: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
      checkAndAutoCompress: vi.fn(),
      addAndPersistMessage: vi.fn(async (message: any) => { ctx.messages.push(message); }),
      generateId: vi.fn().mockReturnValue('generated-msg-id'),
      stripInternalFormatMimicry: vi.fn((content: string) => content),
      updateContextHealth: vi.fn(),
      flushHookMessageBuffer: vi.fn(),
    } as any,
    runFinalizer: {
      finalizeRun: vi.fn(),
      checkAndEmitBudgetStatus: vi.fn().mockReturnValue(false),
      emitTaskProgress: vi.fn(),
      emitTaskComplete: vi.fn(),
      emitTaskStats: vi.fn(),
      tryParseTodosFromResponse: vi.fn(),
      autoAdvanceTodos: vi.fn(),
      processSkillActivation: vi.fn(),
    } as any,
    learningPipeline: { learn: vi.fn() } as any,
  };
}

function buildRuntime(planMode: boolean) {
  const ctx = createMockContext();
  const modules = createMockModules(ctx);
  const runtime = new ConversationRuntime(ctx);
  runtime.setModules(modules.toolEngine, modules.contextAssembly, modules.runFinalizer, modules.learningPipeline);
  if (planMode) runtime.setPlanMode(true);
  modules.toolEngine.runtimeControl = { isPlanMode: () => runtime.isPlanMode(), setPlanMode: (a: boolean) => runtime.setPlanMode(a) };
  return { ctx, modules, runtime };
}

beforeEach(() => {
  vi.clearAllMocks();
  activityMocks.getCurrentActivityContext.mockResolvedValue({
    generatedAtMs: 1_800_000,
    maxChars: 1_000,
    tokenBudgetHint: { maxChars: 1_000, targetTokens: 250 },
    sources: [],
    evidenceRefs: [],
  });
  activityMocks.formatActivityPromptContext.mockReturnValue({
    mode: 'legacySeparate',
    screenMemoryBlock: 'screen context',
    desktopActivityBlock: 'desktop activity',
  });
});

describe('plan exit fallback runtime（ADR-074 K1）', () => {
  it('①(b) plan 正文无退出工具：提醒一次 + 恰好一轮补推理', async () => {
    const { ctx, modules, runtime } = buildRuntime(true);
    modules.contextAssembly.inference
      .mockResolvedValueOnce({ type: 'text', content: PLAN_BODY, finishReason: 'stop' } as ModelResponse)
      .mockResolvedValueOnce({ type: 'text', content: '还是这段计划：\n1. 甲\n2. 乙', finishReason: 'stop' } as ModelResponse);

    await runtime.run('帮我出个方案');

    expect(modules.contextAssembly.inference).toHaveBeenCalledTimes(2);
    const reminderCalls = modules.contextAssembly.injectSystemMessage.mock.calls
      .filter((call: [string, string?]) => call[1] === 'plan-exit-fallback');
    expect(reminderCalls).toHaveLength(1);
    expect(reminderCalls[0][0]).toContain('exit_plan_mode');
    // 原文照常落历史，补推理的正文也落历史
    const assistantTexts = ctx.messages.filter((m) => m.role === 'assistant').map((m) => m.content);
    expect(assistantTexts).toContain(PLAN_BODY);
    // trace：detected + not_applicable（补推理仍是无工具的正文）
    const recorded = (ctx.turnTrace.record as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(recorded).toContain('plan_exit_fallback_detected');
    expect(recorded).toContain('plan_exit_fallback_not_applicable');
  });

  it('③ 补推理交了计划正文：按今日语义收尾，没有第三轮推理', async () => {
    const { modules, runtime } = buildRuntime(true);
    modules.contextAssembly.inference
      .mockResolvedValueOnce({ type: 'text', content: PLAN_BODY } as ModelResponse)
      .mockResolvedValueOnce({ type: 'text', content: '另一版方案：\n1. 先A\n2. 后B' } as ModelResponse)
      .mockResolvedValue({ type: 'text', content: '不该出现的第三轮' } as ModelResponse);

    await runtime.run('继续');

    expect(modules.contextAssembly.inference).toHaveBeenCalledTimes(2);
    expect(modules.contextAssembly.injectSystemMessage.mock.calls
      .filter((call: [string, string?]) => call[1] === 'plan-exit-fallback')).toHaveLength(1);
  });

  it('①(a) 补推理调了退出工具：走既有审批边界，不再注入提醒', async () => {
    const { ctx, modules, runtime } = buildRuntime(true);
    modules.contextAssembly.inference
      .mockResolvedValueOnce({ type: 'text', content: PLAN_BODY } as ModelResponse)
      .mockResolvedValueOnce({
        type: 'tool_use',
        toolCalls: [{ id: 'exit-1', name: 'exit_plan_mode', arguments: { plan: PLAN_BODY } }],
      } as unknown as ModelResponse);
    modules.toolEngine.executeToolsWithHooks.mockResolvedValueOnce([{
      toolCallId: 'exit-1',
      success: true,
      output: '等待审批',
      metadata: { requiresUserConfirmation: true, confirmationType: 'plan_approval' },
    } as ToolResult]);

    await runtime.run('出方案');

    expect(modules.contextAssembly.inference).toHaveBeenCalledTimes(2);
    expect(modules.contextAssembly.injectSystemMessage.mock.calls
      .filter((call: [string, string?]) => call[1] === 'plan-exit-fallback')).toHaveLength(1);
    // 既有边界：等待审批结束 run，不出现 not_applicable
    const recorded = (ctx.turnTrace.record as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(recorded).toContain('plan_exit_fallback_detected');
    expect(recorded).not.toContain('plan_exit_fallback_not_applicable');
  });

  it('①(c) 澄清问题（问号列表）不触发：一轮即收尾', async () => {
    const { ctx, modules, runtime } = buildRuntime(true);
    modules.contextAssembly.inference
      .mockResolvedValue({ type: 'text', content: '先确认几件事：\n1. 用哪个分支？\n2. 何时上线？' } as ModelResponse);

    await runtime.run('看着办');

    expect(modules.contextAssembly.inference).toHaveBeenCalledTimes(1);
    expect(modules.contextAssembly.injectSystemMessage.mock.calls
      .filter((call: [string, string?]) => call[1] === 'plan-exit-fallback')).toHaveLength(0);
    const recorded = (ctx.turnTrace.record as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(recorded).not.toContain('plan_exit_fallback_detected');
  });

  it('①(d) 拒绝/道歉文本不触发', async () => {
    const { modules, runtime } = buildRuntime(true);
    modules.contextAssembly.inference
      .mockResolvedValue({ type: 'text', content: '抱歉，还需要更多信息才能给出方案。' } as ModelResponse);

    await runtime.run('看着办');

    expect(modules.contextAssembly.inference).toHaveBeenCalledTimes(1);
    expect(modules.contextAssembly.injectSystemMessage.mock.calls
      .filter((call: [string, string?]) => call[1] === 'plan-exit-fallback')).toHaveLength(0);
  });

  it('⑤ 非 plan mode：同款计划正文不提醒', async () => {
    const { ctx, modules, runtime } = buildRuntime(false);
    modules.contextAssembly.inference
      .mockResolvedValue({ type: 'text', content: PLAN_BODY } as ModelResponse);

    await runtime.run('直接做');

    expect(modules.contextAssembly.inference).toHaveBeenCalledTimes(1);
    expect(modules.contextAssembly.injectSystemMessage.mock.calls
      .filter((call: [string, string?]) => call[1] === 'plan-exit-fallback')).toHaveLength(0);
    const recorded = (ctx.turnTrace.record as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(recorded).not.toContain('plan_exit_fallback_detected');
  });

  it('④ 补推理中的 Write 调用在 admission 层拒绝、不派发执行', async () => {
    const { ctx, modules, runtime } = buildRuntime(true);
    let blockadeObserved = false;
    modules.contextAssembly.inference
      .mockResolvedValueOnce({ type: 'text', content: PLAN_BODY } as ModelResponse)
      .mockImplementationOnce(async () => {
        // 补推理进行中：兜底旗标必须已置位（写类封锁的开关）
        blockadeObserved = ctx.control.planExitFallbackActive === true;
        return {
          type: 'tool_use',
          toolCalls: [{ id: 'w-1', name: 'Write', arguments: { file_path: '/tmp/planexit-k1-test/x.ts', content: 'x' } }],
        } as unknown as ModelResponse;
      });
    modules.toolEngine.executeToolsWithHooks.mockResolvedValueOnce([{
      toolCallId: 'w-1',
      success: true,
      output: '已写入',
    } as ToolResult]);

    await runtime.run('出方案后直接动手');

    expect(blockadeObserved).toBe(true);
    // admission 拒绝：Write 没有进执行通道
    expect(modules.toolEngine.executeToolsWithHooks).not.toHaveBeenCalled();
    // 拒绝后有指引注入（复用 run 级禁用工具的 admission 通道）
    const guidance = modules.contextAssembly.injectSystemMessage.mock.calls
      .find((call: [string, string?]) => call[1] === 'tool-policy-guard');
    expect(guidance?.[0]).toContain('Write');
  });

  it('④（单元层）MessageProcessor 在封锁旗标 + plan mode 下拒绝 Write', async () => {
    const ctx = createMockContext({ control: ControlState.forTest({ planExitFallbackActive: true } as never) });
    const modules = createMockModules(ctx);
    modules.toolEngine.runtimeControl = { isPlanMode: () => true, setPlanMode: vi.fn() };
    const processor = new MessageProcessor(
      ctx,
      modules.contextAssembly,
      modules.runFinalizer,
      modules.toolEngine,
    );

    const action = await processor.handleToolResponse(
      { type: 'tool_use', toolCalls: [{ id: 'w-2', name: 'Write', arguments: { file_path: 'a.ts', content: 'x' } }] } as unknown as ModelResponse,
      false,
      1,
      { endSpan: vi.fn() },
    );

    expect(action).toBe('continue');
    expect(modules.toolEngine.executeToolsWithHooks).not.toHaveBeenCalled();
  });
});
