import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall, ToolResult } from '../../../src/shared/contract';
import { ToolExecutionEngine } from '../../../src/main/agent/runtime/toolExecutionEngine';
import type { RuntimeContext } from '../../../src/main/agent/runtime/runtimeContext';

const serviceMocks = vi.hoisted(() => {
  const langfuse = {
    startNestedSpan: vi.fn(),
    endSpan: vi.fn(),
  };
  return { langfuse };
});

vi.mock('../../../src/main/services', () => ({
  getConfigService: vi.fn(),
  getAuthService: vi.fn(),
  getBudgetService: vi.fn(),
  getSessionManager: vi.fn(),
  getLangfuseService: () => serviceMocks.langfuse,
  BudgetAlertLevel: {},
}));

vi.mock('../../../src/main/services/citation/citationService', () => ({
  getCitationService: () => ({
    extractAndStore: vi.fn().mockReturnValue([]),
  }),
}));

vi.mock('../../../src/main/services/git/fileWatcherService', () => ({
  getFileWatcherService: () => ({
    getRecentExternalChanges: vi.fn().mockReturnValue([]),
    markAsAgentModified: vi.fn(),
  }),
}));

vi.mock('../../../src/main/services/git/gitStatusService', () => ({
  getGitStatusService: () => ({
    onPostToolUse: vi.fn(),
  }),
}));

vi.mock('../../../src/main/mcp/mcpClient', () => ({
  getMCPClient: () => ({
    getToolAnnotationsMap: () => new Map(),
  }),
}));

function makeToolCall(id: string, path: string): ToolCall {
  return {
    id,
    name: 'read_file',
    arguments: { path },
  };
}

function makeRuntimeContext(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  const onEvent = vi.fn();
  const telemetryAdapter = {
    onTurnStart: vi.fn(),
    onModelCall: vi.fn(),
    onToolCallStart: vi.fn(),
    onToolCallEnd: vi.fn(),
    onTurnEnd: vi.fn(),
  };

  return {
    systemPrompt: '',
    modelConfig: { provider: 'openai', model: 'gpt-test' } as never,
    toolExecutor: { execute: vi.fn() } as never,
    messages: [],
    onEvent,
    modelRouter: {} as never,
    maxIterations: 10,
    workingDirectory: '/tmp/code-agent-test',
    isDefaultWorkingDirectory: false,
    sessionId: 'session-1',
    circuitBreaker: {
      recordFailure: vi.fn().mockReturnValue(false),
      recordSuccess: vi.fn(),
      generateWarningMessage: vi.fn(),
      generateUserErrorMessage: vi.fn(),
    } as never,
    antiPatternDetector: {
      trackToolFailure: vi.fn(),
      clearToolFailure: vi.fn(),
      trackDuplicateCall: vi.fn(),
      trackFileReread: vi.fn(),
      trackToolExecution: vi.fn(),
      generateHardLimitError: vi.fn(),
    } as never,
    goalTracker: { recordAction: vi.fn() } as never,
    nudgeManager: { trackModifiedFile: vi.fn() } as never,
    hookMessageBuffer: {} as never,
    messageHistoryCompressor: {} as never,
    autoCompressor: {} as never,
    compressionState: {} as never,
    compressionPipeline: {} as never,
    telemetryAdapter,
    lastStreamedContent: '',
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
    currentAgentMode: 'agent',
    autoApprovePlan: false,
    enableHooks: true,
    userHooksInitialized: true,
    stopHookRetryCount: 0,
    maxStopHookRetries: 0,
    toolCallRetryCount: 0,
    maxToolCallRetries: 0,
    externalDataCallCount: 0,
    preApprovedTools: new Set(),
    enableToolDeferredLoading: false,
    structuredOutputRetryCount: 0,
    maxStructuredOutputRetries: 0,
    stepByStepMode: false,
    traceId: 'trace-1',
    currentIterationSpanId: 'iteration-1',
    currentTurnId: 'turn-1',
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
    effortLevel: 'medium' as never,
    thinkingStepCount: 0,
    interactionMode: 'cli' as never,
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
    autoCompressThreshold: 0.8,
    contextBudgetRatio: 0,
    genNum: 1,
    initialSystemPromptLength: 0,
    ...overrides,
  };
}

describe('ToolExecutionEngine hook/telemetry argument handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs pre-hooks for parallel-safe tools and records hook-modified args without serializing execution', async () => {
    let activeExecutions = 0;
    let maxActiveExecutions = 0;
    const executedArgs: Array<Record<string, unknown>> = [];

    const toolExecutor = {
      execute: vi.fn(async (_name: string, args: Record<string, unknown>): Promise<ToolResult> => {
        executedArgs.push(args);
        activeExecutions += 1;
        maxActiveExecutions = Math.max(maxActiveExecutions, activeExecutions);
        await new Promise(resolve => setTimeout(resolve, 5));
        activeExecutions -= 1;
        return { toolCallId: '', success: true, output: `read ${String(args.path)}` };
      }),
    };

    const hookManager = {
      triggerPreToolUse: vi.fn(async (_toolName: string, toolInput: string) => {
        const input = JSON.parse(toolInput) as Record<string, unknown>;
        return {
          shouldProceed: true,
          modifiedInput: JSON.stringify({ ...input, path: `${String(input.path)}.hooked` }),
          results: [],
          totalDuration: 1,
        };
      }),
      triggerPostToolUse: vi.fn(async () => ({ shouldProceed: true, results: [], totalDuration: 1 })),
    };

    const planningService = {
      hooks: {
        preToolUse: vi.fn(async () => ({})),
        postToolUse: vi.fn(async () => ({})),
      },
    };

    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      hookManager: hookManager as never,
      planningService: planningService as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      getCurrentAttachments: vi.fn().mockReturnValue([]),
    };
    const runFinalizer = { emitTaskProgress: vi.fn() };
    const conversationRuntime = {
      setPlanMode: vi.fn(),
      isPlanMode: vi.fn().mockReturnValue(false),
      generateAutoContinuationPrompt: vi.fn().mockReturnValue('continue'),
    };
    const engine = new ToolExecutionEngine(ctx);
    engine.setModules(contextAssembly as never, runFinalizer as never, conversationRuntime as never);

    await engine.executeToolsWithHooks([
      makeToolCall('tool-1', 'a.txt'),
      makeToolCall('tool-2', 'b.txt'),
    ]);

    expect(hookManager.triggerPreToolUse).toHaveBeenCalledTimes(2);
    expect(planningService.hooks.preToolUse).toHaveBeenCalledTimes(2);
    expect(planningService.hooks.preToolUse).toHaveBeenNthCalledWith(1, {
      toolName: 'read_file',
      toolParams: { path: 'a.txt.hooked' },
    });
    expect(executedArgs).toEqual([
      { path: 'a.txt.hooked' },
      { path: 'b.txt.hooked' },
    ]);
    expect(maxActiveExecutions).toBe(2);
    expect(ctx.telemetryAdapter?.onToolCallStart).toHaveBeenNthCalledWith(
      1,
      'turn-1',
      'tool-1',
      'read_file',
      { path: 'a.txt.hooked' },
      0,
      true,
    );
    expect(ctx.telemetryAdapter?.onToolCallStart).toHaveBeenNthCalledWith(
      2,
      'turn-1',
      'tool-2',
      'read_file',
      { path: 'b.txt.hooked' },
      1,
      true,
    );
    const startEvents = vi.mocked(ctx.onEvent).mock.calls
      .map(([event]) => event)
      .filter(event => event.type === 'tool_call_start');
    expect(startEvents.map(event => event.data)).toEqual([
      expect.objectContaining({ id: 'tool-1', arguments: { path: 'a.txt.hooked' }, _index: 0 }),
      expect.objectContaining({ id: 'tool-2', arguments: { path: 'b.txt.hooked' }, _index: 1 }),
    ]);
  });

  it('emits tool_call_end when anti-pattern hard limit aborts after execution', async () => {
    serviceMocks.langfuse.endSpan.mockClear();
    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: 'read ok',
      })),
    };
    const antiPatternDetector = {
      trackToolFailure: vi.fn(),
      clearToolFailure: vi.fn(),
      trackDuplicateCall: vi.fn(),
      trackFileReread: vi.fn(),
      trackToolExecution: vi.fn().mockReturnValue('HARD_LIMIT'),
      generateHardLimitError: vi.fn().mockReturnValue('too many reads'),
    };

    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      antiPatternDetector: antiPatternDetector as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      getCurrentAttachments: vi.fn().mockReturnValue([]),
    };
    const runFinalizer = { emitTaskProgress: vi.fn() };
    const conversationRuntime = {
      setPlanMode: vi.fn(),
      isPlanMode: vi.fn().mockReturnValue(false),
      generateAutoContinuationPrompt: vi.fn().mockReturnValue('continue'),
    };
    const engine = new ToolExecutionEngine(ctx);
    engine.setModules(contextAssembly as never, runFinalizer as never, conversationRuntime as never);

    const [result] = await engine.executeToolsWithHooks([
      makeToolCall('tool-hard-limit', 'repeat.txt'),
    ]);

    expect(result).toMatchObject({
      toolCallId: 'tool-hard-limit',
      success: false,
      error: 'too many reads',
    });
    expect(ctx.telemetryAdapter?.onToolCallEnd).toHaveBeenCalledWith(
      'turn-1',
      'tool-hard-limit',
      false,
      'too many reads',
      expect.any(Number),
      undefined,
    );
    expect(vi.mocked(ctx.onEvent).mock.calls.some(([event]) => event.type === 'tool_call_end')).toBe(true);
    expect(serviceMocks.langfuse.endSpan).toHaveBeenCalledWith(
      'tool-tool-hard-limit',
      expect.objectContaining({ success: false, error: 'too many reads' }),
      'ERROR',
      'too many reads',
    );
  });

  it('passes the run-level abort signal into ToolExecutor', async () => {
    const controller = new AbortController();
    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: 'read ok',
      })),
    };
    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      runAbortController: controller,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      getCurrentAttachments: vi.fn().mockReturnValue([]),
    };
    const runFinalizer = { emitTaskProgress: vi.fn() };
    const conversationRuntime = {
      setPlanMode: vi.fn(),
      isPlanMode: vi.fn().mockReturnValue(false),
      generateAutoContinuationPrompt: vi.fn().mockReturnValue('continue'),
    };
    const engine = new ToolExecutionEngine(ctx);
    engine.setModules(contextAssembly as never, runFinalizer as never, conversationRuntime as never);

    await engine.executeToolsWithHooks([
      makeToolCall('tool-abort-signal', 'file.txt'),
    ]);

    expect(toolExecutor.execute).toHaveBeenCalledWith(
      'read_file',
      { path: 'file.txt' },
      expect.objectContaining({ abortSignal: controller.signal }),
    );
  });

  it('suppresses late tool results after run-level cancel', async () => {
    const controller = new AbortController();
    let releaseExecution!: () => void;
    const executionReleased = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    let executionStarted!: () => void;
    const executionStartedPromise = new Promise<void>((resolve) => {
      executionStarted = resolve;
    });

    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => {
        executionStarted();
        await executionReleased;
        return {
          toolCallId: '',
          success: true,
          output: 'late result',
        };
      }),
    };
    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      runAbortController: controller,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      getCurrentAttachments: vi.fn().mockReturnValue([]),
    };
    const runFinalizer = { emitTaskProgress: vi.fn() };
    const conversationRuntime = {
      setPlanMode: vi.fn(),
      isPlanMode: vi.fn().mockReturnValue(false),
      generateAutoContinuationPrompt: vi.fn().mockReturnValue('continue'),
    };
    const engine = new ToolExecutionEngine(ctx);
    engine.setModules(contextAssembly as never, runFinalizer as never, conversationRuntime as never);

    const resultsPromise = engine.executeToolsWithHooks([
      makeToolCall('tool-cancelled', 'file.txt'),
    ]);

    await executionStartedPromise;
    ctx.isCancelled = true;
    controller.abort('run_cancelled');
    releaseExecution();

    const results = await resultsPromise;

    expect(results).toEqual([]);
    expect(ctx.telemetryAdapter?.onToolCallEnd).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.onEvent).mock.calls.some(([event]) => event.type === 'tool_call_end')).toBe(false);
  });
});
