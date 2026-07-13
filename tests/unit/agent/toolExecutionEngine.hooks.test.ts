import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setProtocolToolRegistryPort } from '../../../src/host/tools/protocolToolRegistration';
import type { ToolCall, ToolResult } from '../../../src/shared/contract';
import { ToolExecutionEngine } from '../../../src/host/agent/runtime/toolExecutionEngine';
import { AntiPatternDetector } from '../../../src/host/agent/antiPattern/detector';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { fileReadTracker } from '../../../src/host/tools/fileReadTracker';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import type { Message } from '../../../src/shared/contract';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';

const serviceMocks = vi.hoisted(() => {
  const langfuse = {
    startNestedSpan: vi.fn(),
    endSpan: vi.fn(),
  };
  return { langfuse };
});

vi.mock('../../../src/host/agent/runtime/gameArtifactValidator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/agent/runtime/gameArtifactValidator')>();

  return {
    ...actual,
    validateGameArtifact: vi.fn(async (
      filePath: string,
      options?: Parameters<typeof actual.validateGameArtifact>[1],
    ) => {
      if (/code-agent-artifact-repair-(?:autofinish|target-read-pass)-/.test(filePath)) {
        return {
          shouldValidate: true,
          inferredKind: 'game',
          isComplete: true,
          hasTrailingHtmlContent: false,
          passed: true,
          failures: [],
          checks: [
            'detected game artifact with interactive delivery surface',
            'html document looks complete',
            'runtime smoke passed via interactive test contract',
            'browser visual smoke passed',
          ],
        };
      }

      return actual.validateGameArtifact(filePath, options);
    }),
  };
});

vi.mock('../../../src/host/agent/runtime/browser/visualSmoke', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/agent/runtime/browser/visualSmoke')>();

  return {
    ...actual,
    runBrowserVisualSmoke: vi.fn(async () => ({
      attempted: true,
      passed: true,
      failures: [],
      checks: ['browser visual smoke passed'],
    })),
  };
});

vi.mock('../../../src/host/services', () => ({
  getConfigService: vi.fn(),
  getAuthService: vi.fn(),
  getBudgetService: vi.fn(),
  getSessionManager: vi.fn(),
  getLangfuseService: () => serviceMocks.langfuse,
  BudgetAlertLevel: {},
}));

vi.mock('../../../src/host/services/citation/citationService', () => ({
  getCitationService: () => ({
    extractAndStore: vi.fn().mockReturnValue([]),
  }),
}));

vi.mock('../../../src/host/services/git/fileWatcherService', () => ({
  getFileWatcherService: () => ({
    getRecentExternalChanges: vi.fn().mockReturnValue([]),
    markAsAgentModified: vi.fn(),
  }),
}));

vi.mock('../../../src/host/services/git/gitStatusService', () => ({
  getGitStatusService: () => ({
    onPostToolUse: vi.fn(),
  }),
}));

vi.mock('../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => ({
    getToolAnnotationsMap: () => new Map(),
    getToolDefinitions: () => [],
  }),
}));

function makeToolCall(id: string, path: string): ToolCall {
  return {
    id,
    name: 'read_file',
    arguments: { path },
  };
}

function makeWriteToolCall(id: string, filePath: string): ToolCall {
  return {
    id,
    name: 'Write',
    arguments: {
      file_path: filePath,
      content: `
        <!doctype html>
        <html><body><canvas id="game"></canvas><script>
        window.__GAME_TEST__ = {
          start() { return {}; },
          snapshot() { return {}; },
          runSmokeTest() { return { passed: false, failures: ['still broken'], checks: [] }; }
        };
        </script></body></html>
      `,
    },
  };
}

function makeCompleteHtmlWriteToolCall(id: string, filePath: string): ToolCall {
  return {
    id,
    name: 'Write',
    arguments: { file_path: filePath, content: '<!doctype html><html><body></body></html>' },
  };
}

function makeRuntimeTestableGameHtml(): string {
  return `
    <!doctype html>
    <html>
    <body>
      <canvas id="game" width="320" height="180" style="width: min(90vw, calc(90dvh * 16 / 9)); height: auto; aspect-ratio: 16 / 9; display: block; margin: 0 auto;"></canvas>
      <script>
        const canvas = document.getElementById('game');
        const ctx = canvas.getContext('2d');
        const state = { x: 0, score: 0 };
        function draw() {
          ctx.fillStyle = '#18251f';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#75d7a9';
          ctx.fillRect(28 + state.x, 118, 28, 34);
          ctx.fillStyle = '#f2bd4a';
          ctx.fillRect(0, 154, canvas.width, 10);
        }
        window.__GAME_META__ = {
          domain: 'game',
          controls: { right: 'ArrowRight' },
          levels: [{ id: '1' }],
          progressPlan: [{ input: 'ArrowRight', metric: 'progress', expect: 'increase' }],
          qualityPlan: {
            actorReadable: true,
            mechanics: ['move'],
            rewards: ['score'],
            risks: ['timer'],
            levelsCovered: 1,
            allLevelsReachable: true
          }
        };
        window.addEventListener('keydown', (event) => {
          if (event.code === 'ArrowRight' || event.key === 'ArrowRight') {
            state.x += 5;
            state.score += 1;
            draw();
          }
        });
        window.__GAME_TEST__ = {
          start: () => { state.x = 0; state.score = 0; draw(); },
          reset: () => { state.x = 0; state.score = 0; draw(); },
          snapshot: () => ({ ...state, progress: state.x }),
          step: (input = {}, frames = 1) => {
            for (let index = 0; index < frames; index += 1) {
              if (input.ArrowRight || input.right) {
                state.x += 5;
                state.score += 1;
              }
            }
            draw();
            return window.__GAME_TEST__.snapshot();
          },
          runSmokeTest: () => {
            window.__GAME_TEST__.start();
            window.__GAME_TEST__.step({ ArrowRight: true }, 2);
            return {
              passed: state.x > 0 && state.score > 0,
              checks: ['actor moved', 'reward changed'],
              failures: [],
              coverage: {
                levelsPassed: 1,
                totalLevels: 1,
                allLevelsReachable: true,
                mechanics: ['move'],
                rewards: ['score'],
                risks: ['timer'],
                stateChanges: ['position', 'score']
              }
            };
          }
        };
        draw();
        function gameLoop() { requestAnimationFrame(gameLoop); }
        gameLoop();
      </script>
    </body>
    </html>
  `;
}

function makeAppendToolCall(id: string, filePath: string, final: boolean): ToolCall {
  return {
    id,
    name: 'Append',
    arguments: { file_path: filePath, content: '<chunk>', final },
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
      trackReadOnlyShellCommand: vi.fn(),
      isReadOnlyShellCommand: vi.fn().mockReturnValue(false),
      preflightReadOnlyToolExecution: vi.fn().mockReturnValue(null),
      preflightReadOnlyShellCommand: vi.fn().mockReturnValue(null),
      generateHardLimitError: vi.fn(),
    } as never,
    goalTracker: { recordAction: vi.fn() } as never,
    nudgeManager: {
      trackModifiedFile: vi.fn(),
      checkProgressState: vi.fn(),
      checkPostForceExecute: vi.fn(),
    } as never,
    hookMessageBuffer: {} as never,
    messageHistoryCompressor: {} as never,
    autoCompressor: {} as never,
    contextHealth: ContextHealthState.forTest({ compressionState: {} as never } as never),
    compressionPipeline: {} as never,
    telemetryAdapter,
    turnTrace: {
      setTurn: vi.fn(),
      record: vi.fn(),
      flush: vi.fn(),
      getEvents: vi.fn().mockReturnValue([]),
    } as never,
    turn: TurnState.forTest({
      currentIterationSpanId: 'iteration-1',
      currentTurnId: 'turn-1',
      turnStartTime: Date.now(),
      effortLevel: 'medium' as never,
    }),
    autoApprovePlan: false,
    enableHooks: true,
    maxStopHookRetries: 0,
    maxToolCallRetries: 0,
    control: ControlState.forTest({ isCancelled: false, isInterrupted: false, abortController: null, runAbortController: null, savedMessages: null, externalDataCallCount: 0, preApprovedTools: new Set() } as never),
    enableToolDeferredLoading: false,
    maxStructuredOutputRetries: 0,
    stepByStepMode: false,
    turnQualityState: {},
    goalEvidenceState: { bounces: 0 },
    control: ControlState.forTest({  } as never),
    consecutiveErrors: 0,
    stats: RunStatsState.forTest({ traceId: 'trace-1', totalInputTokens: 0, totalOutputTokens: 0, runStartTime: Date.now(), totalTokensUsed: 0, totalToolCallCount: 0 } as never),
    MAX_CONSECUTIVE_TRUNCATIONS: 3,
    contextHealth: ContextHealthState.forTest({ persistentSystemContext: [] } as never),
    ...overrides,
  };
}

function makePendingGoalMode(): NonNullable<RuntimeContext['goalMode']> {
  return {
    isPending: vi.fn().mockReturnValue(true),
    requestCompletion: vi.fn(),
    getVerifyCommand: vi.fn().mockReturnValue(undefined),
    getReviewCondition: vi.fn().mockReturnValue(undefined),
    getGoal: vi.fn().mockReturnValue('validate artifact'),
    markMet: vi.fn(),
    clearCompletionRequest: vi.fn(),
    // 这些 hook 测试不测 swarm；返回 false 让 applySwarmBudgetClamp 等 swarm 路径直接 no-op
    // （生产代码 swarmGoalIntegration 会调 goalMode.allowsSwarm()，mock 缺它会抛 TypeError）。
    allowsSwarm: vi.fn().mockReturnValue(false),
  } as unknown as NonNullable<RuntimeContext['goalMode']>;
}

function makeMessageProcessorDeps(_ctx: RuntimeContext) {
  const injected: string[] = [];
  return {
    contextAssembly: {
      generateId: vi.fn().mockReturnValue('tool-msg-1'),
      addAndPersistMessage: vi.fn(),
      injectSystemMessage: vi.fn((msg: string) => {
        injected.push(msg);
      }),
      stripInternalFormatMimicry: vi.fn((value: string) => value),
      flushHookMessageBuffer: vi.fn(),
      updateContextHealth: vi.fn(),
      checkAndAutoCompress: vi.fn(),
      maybeInjectThinking: vi.fn(),
    } as any,
    runFinalizer: {
      autoAdvanceTodos: vi.fn(),
      emitTaskProgress: vi.fn(),
      tryParseTodosFromResponse: vi.fn(),
    } as any,
    injected,
  };
}

describe('ToolExecutionEngine hook/telemetry argument handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileReadTracker.clear();
  });

  it('injects an artifact file-write correction after mkdir-only bootstrap', async () => {
    const { MessageProcessor } = await import('../../../src/host/agent/runtime/messageProcessor');
    const userMessage: Message = {
      id: 'u1',
      role: 'user',
      content: '生成一个单文件 HTML 游戏，并保存到 /private/tmp/corgi-platformer.html',
      timestamp: Date.now(),
    };
    const ctx = makeRuntimeContext({
      messages: [userMessage],
    });
    const deps = makeMessageProcessorDeps(ctx);
    const toolEngine = {
      executeToolsWithHooks: vi.fn().mockResolvedValue([
        {
          toolCallId: 'mkdir-1',
          success: true,
          output: '[cwd: /tmp]\\n',
          duration: 5,
        },
      ] satisfies ToolResult[]),
    } as any;

    const processor = new MessageProcessor(
      ctx,
      deps.contextAssembly,
      deps.runFinalizer,
      toolEngine,
    );

    const action = await processor.handleToolResponse(
      {
        type: 'tool_use',
        toolCalls: [
          {
            id: 'mkdir-1',
            name: 'Bash',
            arguments: {
              command: 'mkdir -p /private/tmp',
              description: 'Create output directory',
            },
          },
        ],
      } as any,
      false,
      1,
      { endSpan: vi.fn() } as any,
    );

    expect(action).toBe('continue');
    expect(deps.injected.some((msg) => msg.includes('<artifact-file-write-required>'))).toBe(true);
    expect(deps.injected.some((msg) => msg.includes('/private/tmp/corgi-platformer.html'))).toBe(true);
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
      pushPersistentSystemContext: vi.fn(),
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

  it('emits tool_call_end when anti-pattern hard limit blocks before execution', async () => {
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
      trackToolExecution: vi.fn(),
      preflightReadOnlyToolExecution: vi.fn().mockReturnValue('HARD_LIMIT'),
      generateHardLimitError: vi.fn().mockReturnValue('too many reads'),
    };

    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      antiPatternDetector: antiPatternDetector as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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
      metadata: expect.objectContaining({
        blocked: true,
        skipped: true,
        hardLimitPreflight: true,
      }),
    });
    expect(toolExecutor.execute).not.toHaveBeenCalled();
    expect(antiPatternDetector.trackToolExecution).not.toHaveBeenCalled();
    expect(ctx.telemetryAdapter?.onToolCallEnd).toHaveBeenCalledWith(
      'turn-1',
      'tool-hard-limit',
      false,
      'too many reads',
      expect.any(Number),
      undefined,
      expect.objectContaining({
        blocked: true,
        skipped: true,
        hardLimitPreflight: true,
      }),
    );
    expect(vi.mocked(ctx.onEvent).mock.calls.some(([event]) => event.type === 'tool_call_end')).toBe(true);
    expect(serviceMocks.langfuse.endSpan).not.toHaveBeenCalled();
    expect(ctx.control.forceFinalResponseReason).toContain('连续只读操作达到硬阈值');
    expect(ctx.control.forceFinalResponsePrompt).toContain('force-final-response');
  });

  it('blocks the fifteenth read and skips the sixteenth sequential read in the same batch', async () => {
    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: 'read ok',
      })),
    };
    const antiPatternDetector = new AntiPatternDetector();
    for (let index = 0; index < 14; index += 1) {
      antiPatternDetector.trackToolExecution('Read', true);
    }

    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      antiPatternDetector,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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

    const results = await engine.executeToolsWithHooks([
      { id: 'tool-read-15', name: 'Read', arguments: { file_path: '/tmp/a.ts' } } as ToolCall,
      { id: 'tool-read-16', name: 'Read', arguments: { file_path: '/tmp/b.ts' } } as ToolCall,
    ]);

    expect(toolExecutor.execute).not.toHaveBeenCalled();
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      toolCallId: 'tool-read-15',
      success: false,
      metadata: expect.objectContaining({
        hardLimitPreflight: true,
        skipped: true,
      }),
    });
    expect(results[1]).toMatchObject({
      toolCallId: 'tool-read-16',
      success: false,
      metadata: expect.objectContaining({
        skipped: true,
        forceFinalResponseReason: expect.stringContaining('连续只读操作达到硬阈值'),
      }),
    });
    expect(ctx.control.forceFinalResponseReason).toContain('连续只读操作达到硬阈值');

    const toolEvents = vi.mocked(ctx.onEvent).mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'tool_call_start' || event.type === 'tool_call_end');
    expect(toolEvents.map((event) => event.type)).toEqual([
      'tool_call_start',
      'tool_call_end',
      'tool_call_start',
      'tool_call_end',
    ]);
    expect(toolEvents[0]?.data).toMatchObject({ id: 'tool-read-15' });
    expect(toolEvents[1]?.data).toMatchObject({ toolCallId: 'tool-read-15' });
    expect(toolEvents[2]?.data).toMatchObject({ id: 'tool-read-16' });
    expect(toolEvents[3]?.data).toMatchObject({ toolCallId: 'tool-read-16' });
  });

  it('preflights batched read-only Bash calls before the hard-limit command executes', async () => {
    const toolExecutor = {
      execute: vi.fn(async (_toolName: string, args: Record<string, unknown>): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: `read ok: ${String(args.command)}`,
      })),
    };

    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      antiPatternDetector: new AntiPatternDetector(),
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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

    const calls = Array.from({ length: 16 }, (_, index) => {
      const id = String(index + 1).padStart(2, '0');
      return {
        id: `bash-read-${id}`,
        name: 'Bash',
        arguments: { command: `cat evidence-${id}.txt`, description: `read ${id}` },
      } as ToolCall;
    });

    const results = await engine.executeToolsWithHooks(calls);

    expect(toolExecutor.execute).toHaveBeenCalledTimes(14);
    expect(toolExecutor.execute).not.toHaveBeenCalledWith(
      'Bash',
      expect.objectContaining({ command: 'cat evidence-15.txt' }),
      expect.anything(),
    );
    expect(toolExecutor.execute).not.toHaveBeenCalledWith(
      'Bash',
      expect.objectContaining({ command: 'cat evidence-16.txt' }),
      expect.anything(),
    );
    expect(results).toHaveLength(16);
    expect(results.slice(0, 14).every((result) => result.success)).toBe(true);
    expect(results[14]).toMatchObject({
      toolCallId: 'bash-read-15',
      success: false,
      metadata: expect.objectContaining({
        hardLimitPreflight: true,
        skipped: true,
      }),
    });
    expect(results[15]).toMatchObject({
      toolCallId: 'bash-read-16',
      success: false,
      metadata: expect.objectContaining({
        skipped: true,
        forceFinalResponseReason: expect.stringContaining('执行前阻止 Bash'),
      }),
    });
  });

  it('preflights a runaway WebSearch loop and forces the agent to answer at the hard limit', async () => {
    // 回归：模型反复 WebSearch 不收敛（拿到好结果仍自称"截断"重搜）时，
    // 之前因 WebSearch 不在 READ_ONLY_TOOLS，只读循环熔断从不触发，会话停在空白"待处理"。
    // 现在 WebSearch 计入连续只读操作 → 第 15 次硬阈值 preflight 拦截 → 强制收尾。
    const toolExecutor = {
      execute: vi.fn(async (_toolName: string, args: Record<string, unknown>): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: `search ok: ${String(args.query)}`,
      })),
    };

    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      antiPatternDetector: new AntiPatternDetector(),
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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

    const calls = Array.from({ length: 16 }, (_, index) => {
      const id = String(index + 1).padStart(2, '0');
      return {
        id: `websearch-${id}`,
        name: 'WebSearch',
        arguments: { query: `AI news June 2026 attempt ${id}`, recency: 'week' },
      } as ToolCall;
    });

    const results = await engine.executeToolsWithHooks(calls);

    // 前 14 次真正执行，第 15 次被 preflight 硬上限拦截（不再无限搜下去）
    expect(toolExecutor.execute).toHaveBeenCalledTimes(14);
    expect(results).toHaveLength(16);
    expect(results.slice(0, 14).every((result) => result.success)).toBe(true);
    expect(results[14]).toMatchObject({
      toolCallId: 'websearch-15',
      success: false,
      metadata: expect.objectContaining({
        hardLimitPreflight: true,
        skipped: true,
      }),
    });
    // 第 16 次被强制收尾跳过，理由指向只读硬阈值
    expect(results[15]).toMatchObject({
      toolCallId: 'websearch-16',
      success: false,
      metadata: expect.objectContaining({
        skipped: true,
        forceFinalResponseReason: expect.stringContaining('执行前阻止 WebSearch'),
      }),
    });
    // 强制收尾标记已激活，HARD_LIMIT 错误把"基于已有证据作答"回灌给模型 → 不再空白会话
    expect(ctx.control.forceFinalResponseReason).toContain('连续只读操作达到硬阈值');
    expect(results[14].error).toContain('基于已经获取到的文件或搜索证据');
  });

  it('marks successful read_file output as preserved file evidence', async () => {
    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: '     1\talpha\n     2\tbeta',
      })),
    };

    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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
      makeToolCall('tool-read', '/tmp/evidence.txt'),
    ]);

    expect(result.success).toBe(true);
    expect(result.metadata).toMatchObject({
      preserveObservation: true,
      evidenceKind: 'file_read',
      filePath: '/tmp/evidence.txt',
    });
  });

  it('emits compact observation payloads for large artifact repair target reads', async () => {
    const largeHtml = [
      '<!doctype html>',
      '<html>',
      '<body>',
      '<script>',
      'const filler = `' + 'x'.repeat(18000) + '`;',
      'window.__GAME_META__ = { progressPlan: [{ input: "ArrowRight", metric: "progress", expect: "increase" }] };',
      'window.__GAME_TEST__ = {',
      '  start() { return true; },',
      '  snapshot() { return { progress: 0 }; },',
      '  step() { return { progress: 1 }; },',
      '  runSmokeTest() { return { passed: false, failures: ["coverage"], coverage: {} }; },',
      '};',
      '</script>',
      '</body>',
      '</html>',
    ].join('\n');
    const targetFile = '/tmp/game.html';
    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: largeHtml,
      })),
    };

    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      artifactRepairGuard: {
        targetFile,
        attempts: 1,
        phase: 'initial_repair',
        patched: false,
      },
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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
      { id: 'tool-read-large-artifact', name: 'Read', arguments: { file_path: targetFile } } as ToolCall,
    ]);

    expect(result.success).toBe(true);
    expect(result.output).toContain('x'.repeat(4000));

    const toolEndEvent = vi.mocked(ctx.onEvent).mock.calls
      .map(([event]) => event)
      .find((event: any) => event?.type === 'tool_call_end') as any;

    expect(toolEndEvent?.data?.output).toContain('<artifact-repair-file-read-preview>');
    expect(toolEndEvent?.data?.output).toContain('Target file read: /tmp/game.html');
    expect(toolEndEvent?.data?.output).toContain('Important anchors:');
    expect(toolEndEvent?.data?.output).not.toContain('x'.repeat(4000));
    expect(toolEndEvent?.data?.metadata?.artifactRepairPreview).toBe(true);
    expect(toolEndEvent?.data?.metadata?.originalOutputLength).toBe(largeHtml.length);
  });

  it('preserves exact observation payloads for ranged artifact repair target reads', async () => {
    const rangedHtml = [
      'window.__GAME_TEST__ = {',
      '  runSmokeTest() {',
      '    const before = this.snapshot();',
      '    const after = this.step({ ArrowRight: true }, 80);',
      "    if (after.playerX > before.playerX) coverage.mechanics.push('movement');",
      '  }',
      '};',
      'const filler = `' + 'x'.repeat(6000) + '`;',
    ].join('\n');
    const targetFile = '/tmp/game.html';
    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: rangedHtml,
      })),
    };

    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      artifactRepairGuard: {
        targetFile,
        attempts: 1,
        phase: 'initial_repair',
        patched: false,
      },
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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
      { id: 'tool-read-ranged-artifact', name: 'Read', arguments: { file_path: targetFile, offset: 1086, limit: 200 } } as ToolCall,
    ]);

    expect(result.success).toBe(true);
    const toolEndEvent = vi.mocked(ctx.onEvent).mock.calls
      .map(([event]) => event)
      .find((event: any) => event?.type === 'tool_call_end') as any;

    expect(toolEndEvent?.data?.output).toContain('window.__GAME_TEST__ = {');
    expect(toolEndEvent?.data?.output).toContain("coverage.mechanics.push('movement')");
    expect(toolEndEvent?.data?.output).not.toContain('<artifact-repair-file-read-preview>');
    expect(toolEndEvent?.data?.metadata?.rangedRead).toBe(true);
    expect(toolEndEvent?.data?.metadata?.artifactRepairPreview).not.toBe(true);
  });

  it('expands targeted contract Edit anchors to the current full contract region during artifact repair', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-contract-anchor-'));
    const targetFile = path.join(dir, 'game.html');
    const fileContent = [
      '<!doctype html>',
      '<html><body><script>',
      'window.__GAME_TEST__ = {',
      '  start() { return { mode: "playing" }; },',
      '  reset() { return { mode: "playing" }; },',
      '  snapshot() { return { progress: 0 }; },',
      '  step(input, frames) { return { progress: frames || 0 }; },',
      '  runSmokeTest() {',
      '    const checks = [];',
      '    const failures = [];',
      '    let mechanics = new Set();',
      '    return { passed: failures.length === 0, checks, failures, coverage: { mechanics: [...mechanics] } };',
      '  }',
      '};',
      '  start() { return { mode: "dangling duplicate tail" }; },',
      '  runSmokeTest() { return { passed: false, failures: ["duplicate tail"] }; }',
      '};',
      '// Auto-run smoke test in headless mode',
      '</script></body></html>',
    ].join('\n');
    await writeFile(targetFile, fileContent, 'utf-8');

    const toolExecutor = {
      execute: vi.fn(async (_toolName: string, args: Record<string, unknown>): Promise<ToolResult> => {
        const edits = args.edits as Array<Record<string, unknown>>;
        return {
          toolCallId: '',
          success: true,
          output: String(edits?.[0]?.old_text || ''),
        };
      }),
    };

    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
      artifactRepairGuard: {
        targetFile,
        attempts: 3,
        phase: 'read_then_patch',
        patched: false,
        activeIssueCodes: ['coverage_without_runtime_evidence'],
      },
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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
      {
        id: 'tool-contract-region-edit',
        name: 'Edit',
        arguments: {
          file_path: targetFile,
          edits: [{
            old_text: 'runSmokeTest() {\n    const checks = [];\n    const failures = [];\n    let mechanics = new Set();',
            new_text: 'window.__GAME_TEST__ = {\n  start() { return { mode: "patched" }; }\n};',
          }],
        },
      } as ToolCall,
    ]);

    void result;
    expect(toolExecutor.execute).toHaveBeenCalledTimes(1);
    const executeArgs = vi.mocked(toolExecutor.execute).mock.calls[0]?.[1] as Record<string, unknown>;
    const expandedOldText = ((executeArgs.edits as Array<Record<string, unknown>>)[0]?.old_text as string) || '';
    expect(expandedOldText).toContain('window.__GAME_TEST__ = {');
    expect(expandedOldText).toContain('let mechanics = new Set();');
    expect(expandedOldText).toContain('runSmokeTest() { return { passed: false, failures: ["duplicate tail"] }; }');
    expect(expandedOldText).not.toContain('// Auto-run smoke test in headless mode');
  });

  it('expands partial contract-closing edits to the current method region during artifact repair', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-partial-contract-edit-'));
    const targetFile = path.join(dir, 'game.html');
    const fileContent = [
      '<!doctype html>',
      '<html><body><script>',
      'window.__GAME_TEST__ = {',
      '  start() { return { mode: "playing" }; },',
      '  reset() { return { mode: "playing" }; },',
      '  snapshot() { return { progress: 0 }; },',
      '  step(input, frames) { return { progress: frames || 0 }; },',
      '  runSmokeTest() {',
      '    const checks = [];',
      '    const failures = [];',
      '    let mechanics = new Set();',
      '    return { passed: failures.length === 0, checks, failures, coverage: { mechanics: [...mechanics] } };',
      '  }',
      '};',
      '// Auto-run smoke test in headless mode',
      '</script></body></html>',
    ].join('\n');
    await writeFile(targetFile, fileContent, 'utf-8');

    const toolExecutor = {
      execute: vi.fn(async (_toolName: string, args: Record<string, unknown>): Promise<ToolResult> => {
        const edits = args.edits as Array<Record<string, unknown>>;
        return {
          toolCallId: '',
          success: true,
          output: String(edits?.[0]?.old_text || ''),
        };
      }),
    };

    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
      artifactRepairGuard: {
        targetFile,
        attempts: 4,
        phase: 'read_then_patch',
        activeIssueCodes: ['coverage_without_runtime_evidence'],
      },
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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
      {
        id: 'tool-partial-contract-closing-edit',
        name: 'Edit',
        arguments: {
          file_path: targetFile,
          edits: [{
            old_text: 'runSmokeTest() {\n    const checks = [];\n    const failures = [];\n    let mechanics = new Set();',
            new_text: 'runSmokeTest() {\n    return { passed: true, checks: [], failures: [], coverage: { mechanics: ["move"] } };\n  }\n};',
          }],
        },
      } as ToolCall,
    ]);

    void result;
    expect(toolExecutor.execute).toHaveBeenCalledTimes(1);
    const executeArgs = vi.mocked(toolExecutor.execute).mock.calls[0]?.[1] as Record<string, unknown>;
    const expandedEdit = (executeArgs.edits as Array<Record<string, unknown>>)[0] || {};
    const expandedOldText = (expandedEdit.old_text as string) || '';
    const expandedNewText = (expandedEdit.new_text as string) || '';
    expect(expandedOldText.startsWith('runSmokeTest() {')).toBe(true);
    expect(expandedOldText).not.toContain('window.__GAME_TEST__ = {');
    expect(expandedOldText).not.toContain('snapshot() { return { progress: 0 }; }');
    expect(expandedOldText).toContain('runSmokeTest() {');
    expect(expandedNewText.startsWith('runSmokeTest() {')).toBe(true);
    expect(expandedNewText).not.toMatch(/\n\s*};\s*$/);
    expect(expandedOldText).not.toContain('// Auto-run smoke test in headless mode');
  });

  it('blocks incomplete runSmokeTest fragment replacements during artifact repair', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-incomplete-contract-edit-'));
    const targetFile = path.join(dir, 'game.html');
    await writeFile(targetFile, [
      '<!doctype html>',
      '<html><body><script>',
      'window.__GAME_TEST__ = {',
      '  start() { return { mode: "playing" }; },',
      '  snapshot() { return { progress: 0 }; },',
      '  step(input, frames) { return { progress: frames || 0 }; },',
      '  runSmokeTest() {',
      '    const checks = [];',
      '    const failures = [];',
      '    return { passed: false, checks, failures, coverage: {} };',
      '  }',
      '};',
      '</script></body></html>',
    ].join('\n'), 'utf-8');

    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: 'edit ok',
      })),
    };
    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
      artifactRepairGuard: {
        targetFile,
        attempts: 2,
        phase: 'read_then_patch',
        activeIssueCodes: ['coverage_without_runtime_evidence'],
      },
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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
      {
        id: 'tool-incomplete-run-smoke-edit',
        name: 'Edit',
        arguments: {
          file_path: targetFile,
          edits: [{
            old_text: 'runSmokeTest() {\n    const checks = [];\n    const failures = [];',
            new_text: 'runSmokeTest() {\n    const checks = [];\n    const failures = [];\n    const before = this.snapshot();',
          }],
        },
      } as ToolCall,
    ]);

    expect(result.success).toBe(false);
    expect(result.error).toContain('fragment of `runSmokeTest()`');
    expect(toolExecutor.execute).not.toHaveBeenCalled();
  });

  it('summarizes large Edit arguments in tool_call_start events without changing execution input', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-tool-call-start-summary-'));
    const targetFile = path.join(dir, 'game.html');
    const oldText = `window.__GAME_TEST__ = {\n${'a'.repeat(5200)}\n};`;
    const newText = `window.__GAME_TEST__ = {\n${'b'.repeat(5400)}\n};`;
    await writeFile(targetFile, oldText, 'utf-8');

    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: 'edit ok',
      })),
    };

    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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
      {
        id: 'tool-large-edit-start-event',
        name: 'Edit',
        arguments: {
          file_path: targetFile,
          edits: [{ old_text: oldText, new_text: newText }],
        },
      } as ToolCall,
    ]);

    void result;
    expect(toolExecutor.execute).toHaveBeenCalledTimes(1);
    const startEvent = vi.mocked(ctx.onEvent).mock.calls
      .map(([event]) => event)
      .find((event: any) => event?.type === 'tool_call_start') as any;

    const observedEdit = startEvent?.data?.arguments?.edits?.[0];
    expect(observedEdit?.old_text).toContain('[');
    expect(observedEdit?.old_text).toContain('chars omitted');
    expect(observedEdit?.old_text_length).toBe(oldText.length);
    expect(observedEdit?.new_text_length).toBe(newText.length);
    expect(String(observedEdit?.old_text || '').length).toBeLessThan(oldText.length);
    expect(String(observedEdit?.new_text || '').length).toBeLessThan(newText.length);

    const executeArgs = vi.mocked(toolExecutor.execute).mock.calls[0]?.[1] as Record<string, unknown>;
    const executedEdit = (executeArgs.edits as Array<Record<string, unknown>>)[0];
    expect(executedEdit.old_text).toBe(oldText);
    expect(executedEdit.new_text).toBe(newText);
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
      control: ControlState.forTest({ runAbortController: controller } as never),
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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

  it('injects validation feedback after writing a game HTML artifact', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-runtime-game-'));
    const filePath = path.join(dir, 'game.html');
    await writeFile(filePath, `
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          window.__GAME_META__ = {
            domain: 'game',
            controls: { right: 'ArrowRight' },
            levels: [{ id: '1' }],
            progressPlan: [{ input: 'ArrowRight', metric: 'progress', expect: 'increase' }]
          };
          const player = { x: 0, y: 0 };
          let score = 0;
          window.addEventListener('keydown', () => {});
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `, 'utf-8');

    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: `Created file: ${filePath}`,
      })),
    };
    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
      goalMode: makePendingGoalMode(),
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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
      makeWriteToolCall('tool-game-write', filePath),
    ]);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Artifact validation failed');
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('<artifact-validation-failed kind="interactive_artifact">'),
    );
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('交互测试合约'),
    );
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('runSmokeTest'),
    );
    expect(fileReadTracker.hasBeenRead(filePath)).toBe(true);
  });

  it('escalates repeated game artifact validation failures into targeted repair mode', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-runtime-game-repair-'));
    const filePath = path.join(dir, 'game.html');
    await writeFile(filePath, `
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          window.__GAME_META__ = {
            domain: 'game',
            controls: { right: 'ArrowRight' },
            levels: [{ id: '1' }],
            progressPlan: [{ input: 'ArrowRight', metric: 'progress', expect: 'increase' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['move'],
              rewards: ['score'],
              risks: ['timer']
            }
          };
          const state = {
            x: 0,
            score: 0,
            distanceTraveled: 0,
            obstaclesAvoided: 0,
            pickupsCollected: 0,
            gameOver: false
          };
          window.__GAME_TEST__ = {
            runSmokeTest: () => ({
              passed: false,
              checks: [],
              failures: ['progress metric did not increase'],
              coverage: {
                levelsPassed: 0,
                totalLevels: 1,
                allLevelsReachable: false,
                mechanics: [],
                rewards: [],
                risks: []
              }
            })
          };
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `, 'utf-8');

    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: `Updated file: ${filePath}`,
      })),
    };
    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
      goalMode: makePendingGoalMode(),
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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

    const [first] = await engine.executeToolsWithHooks([
      makeWriteToolCall('tool-game-repair-1', filePath),
    ]);
    const [second] = await engine.executeToolsWithHooks([
      makeWriteToolCall('tool-game-repair-2', filePath),
    ]);
    const [third] = await engine.executeToolsWithHooks([
      makeWriteToolCall('tool-game-repair-3', filePath),
    ]);

    expect(first.metadata?.artifactValidation).toMatchObject({
      failed: true,
      attempts: 1,
      phase: 'baseline_repair',
    });
    expect(second.metadata?.artifactValidation).toMatchObject({
      failed: true,
      attempts: 2,
      phase: 'targeted_repair',
    });
    // 同样的失败连续 3 轮：patience 停滞检测（连续 2 轮未刷新最佳）触发
    // 策略切换——第 3 轮不再走 read_then_patch 补丁阶梯，改干净重写。
    expect(third.metadata?.artifactValidation).toMatchObject({
      failed: true,
      attempts: 3,
      phase: 'fresh_rewrite',
    });
    expect((third.metadata?.artifactValidation as any)?.repairSpec).toMatchObject({
      kind: 'game_artifact_repair',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'missing_user_input' }),
        expect.objectContaining({ code: 'missing_contract_start' }),
        expect.objectContaining({ code: 'missing_contract_snapshot' }),
      ]),
    });

    const injectedMessages = vi.mocked(contextAssembly.injectSystemMessage).mock.calls
      .map(([message]) => message);
    expect(injectedMessages).toEqual(expect.arrayContaining([
      expect.stringContaining('attempts: 2'),
      expect.stringContaining('repair phase: targeted_repair'),
      expect.stringContaining('<artifact_repair_spec>'),
      expect.stringContaining('"missing_contract_start"'),
      expect.stringContaining('只允许改这个文件'),
      expect.stringContaining('Repair 权限已经收窄到目标文件和验证命令'),
      expect.stringContaining('下一步动作必须是 Edit / Append / Bash(validator) 之一'),
      expect.stringContaining('contract、metric 或 coverage 缺口'),
      expect.stringContaining('coverage 只能来自真实状态变化'),
      expect.stringContaining('敌人/尖刺/能力道具存在'),
    ]));
    // 第 3 轮：patience 停滞检测触发策略切换——干净重写而非 read_then_patch 补丁阶梯
    expect(injectedMessages).toEqual(expect.arrayContaining([
      expect.stringContaining('attempts: 3'),
      expect.stringContaining('repair phase: fresh_rewrite'),
      expect.stringContaining('补丁式修复已停用'),
      expect.stringContaining('一次完整 Write 输出全新实现'),
      expect.stringContaining('<artifact-fresh-rewrite>'),
      expect.stringContaining('不得回退'),
      expect.stringContaining(filePath),
    ]));
  });

  it('blocks non-target reads during artifact repair and only allows verification bash after patching', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-guard-'));
    const targetFile = path.join(dir, 'game.html');
    const otherFile = path.join(dir, 'notes.txt');
    await writeFile(targetFile, '<!doctype html><html><body></body></html>', 'utf-8');
    await writeFile(otherFile, 'notes', 'utf-8');

    const toolExecutor = {
      execute: vi.fn(async (name: string): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: `${name} ok`,
      })),
    };
    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
      artifactRepairGuard: {
        targetFile,
        attempts: 2,
        phase: 'targeted_repair',
      },
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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

    const [blockedRead] = await engine.executeToolsWithHooks([
      makeToolCall('repair-read-other', otherFile),
    ]);
    expect(blockedRead.success).toBe(false);
    expect(blockedRead.error).toContain('Read is limited to the target artifact file during repair');
    expect(toolExecutor.execute).not.toHaveBeenCalled();
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('<artifact-repair-tool-blocked>'),
    );

    ctx.turn.clearReinference();
    vi.mocked(toolExecutor.execute).mockClear();
    const [allowedRead] = await engine.executeToolsWithHooks([
      makeToolCall('repair-read-target', targetFile),
    ]);
    expect(allowedRead.success).toBe(true);
    expect(toolExecutor.execute).toHaveBeenCalledTimes(1);

    ctx.turn.clearReinference();
    vi.mocked(toolExecutor.execute).mockClear();
    const [blockedBash] = await engine.executeToolsWithHooks([
      {
        id: 'repair-bash-read',
        name: 'Bash',
        arguments: { command: 'npm run test -- game-artifact-validator' },
      },
    ]);
    expect(blockedBash.success).toBe(false);
    expect(blockedBash.error).toContain('Bash verification is only available after you patch the target artifact');
    expect(toolExecutor.execute).not.toHaveBeenCalled();

    ctx.turn.clearReinference();
    ctx.artifactRepairGuard!.patched = true;
    vi.mocked(toolExecutor.execute).mockClear();
    const [allowedBash] = await engine.executeToolsWithHooks([
      {
        id: 'repair-bash-verify',
        name: 'Bash',
        arguments: { command: 'npm run test -- game-artifact-validator' },
      },
    ]);
    expect(allowedBash.success).toBe(true);
    expect(toolExecutor.execute).toHaveBeenCalledTimes(1);
  });

  it('blocks bash source reads during artifact repair while allowing piped validator output truncation', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-bash-'));
    const targetFile = path.join(dir, 'game.html');
    await writeFile(targetFile, '<!doctype html><html><body></body></html>', 'utf-8');

    const toolExecutor = {
      execute: vi.fn(async (name: string): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: `${name} ok`,
      })),
    };
    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
      artifactRepairGuard: {
        targetFile,
        attempts: 0,
        phase: 'initial_repair',
      },
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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

    const [blockedValidatorSourceBash] = await engine.executeToolsWithHooks([
      {
        id: 'repair-bash-read-validator',
        name: 'Bash',
        arguments: { command: 'sed -n "1,200p" src/host/agent/runtime/gameArtifactValidator.ts' },
      },
    ]);
    expect(blockedValidatorSourceBash.success).toBe(false);
    expect(blockedValidatorSourceBash.error).toContain('Bash verification is only available after you patch the target artifact');
    expect(toolExecutor.execute).not.toHaveBeenCalled();

    ctx.turn.clearReinference();
    ctx.artifactRepairGuard!.patched = true;
    vi.mocked(toolExecutor.execute).mockClear();
    const [allowedPipedValidator] = await engine.executeToolsWithHooks([
      {
        id: 'repair-bash-validator-head',
        name: 'Bash',
        arguments: { command: 'npx tsx -e "console.log(`validator ok`)" 2>&1 | head -100' },
      },
    ]);
    expect(allowedPipedValidator.success).toBe(true);
    expect(toolExecutor.execute).toHaveBeenCalledTimes(1);
  });

  it('allows complete target-file writes but blocks incomplete writes, non-target mutation, and Task during artifact repair', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-mutation-'));
    const targetFile = path.join(dir, 'game.html');
    const otherFile = path.join(dir, 'notes.txt');
    await writeFile(targetFile, '<!doctype html><html><body></body></html>', 'utf-8');
    await writeFile(otherFile, 'notes', 'utf-8');

    const toolExecutor = {
      execute: vi.fn(async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
        if (name === 'Write' && typeof args.file_path === 'string' && typeof args.content === 'string') {
          await writeFile(args.file_path, args.content, 'utf-8');
        }
        return {
          toolCallId: '',
          success: true,
          output: `${name} ok`,
        };
      }),
    };
    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
      artifactRepairGuard: {
        targetFile,
        attempts: 3,
        phase: 'read_then_patch',
      },
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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

    const [blockedIncompleteWrite] = await engine.executeToolsWithHooks([
      {
        id: 'repair-write-incomplete-target',
        name: 'Write',
        arguments: { file_path: targetFile, content: '<html></html>' },
      } as ToolCall,
    ]);
    expect(blockedIncompleteWrite.success).toBe(false);
    expect(blockedIncompleteWrite.error).toContain('interactive test contract');
    expect(toolExecutor.execute).not.toHaveBeenCalled();

    ctx.turn.clearReinference();
    const [allowedWrite] = await engine.executeToolsWithHooks([
      {
        id: 'repair-write-target',
        name: 'Write',
        arguments: { file_path: targetFile, content: makeRuntimeTestableGameHtml() },
      } as ToolCall,
    ]);
    expect(allowedWrite.success).toBe(true);
    expect(ctx.artifactRepairGuard).toBeUndefined();
    expect(toolExecutor.execute).toHaveBeenCalledTimes(1);

    ctx.artifactRepairGuard = {
      targetFile,
      attempts: 3,
      phase: 'read_then_patch',
    };
    ctx.turn.clearReinference();
    vi.mocked(toolExecutor.execute).mockClear();
    const [blockedWrite] = await engine.executeToolsWithHooks([
      makeCompleteHtmlWriteToolCall('repair-write-other', otherFile),
    ]);
    expect(blockedWrite.success).toBe(false);
    expect(blockedWrite.error).toContain('File mutation is limited to the target artifact file during repair');
    expect(toolExecutor.execute).not.toHaveBeenCalled();

    ctx.artifactRepairGuard = {
      targetFile,
      attempts: 3,
      phase: 'read_then_patch',
    };
    ctx.turn.clearReinference();
    const [blockedTask] = await engine.executeToolsWithHooks([
      {
        id: 'repair-task-validator',
        name: 'Task',
        arguments: {
          subagent_type: 'explore',
          prompt: 'Read the validator source and summarize it.',
        },
      } as ToolCall,
    ]);
    expect(blockedTask.success).toBe(false);
    expect(blockedTask.error).toContain('Task is blocked during artifact repair');
    expect(toolExecutor.execute).not.toHaveBeenCalled();
  });

  it('blocks non-substantive artifact repair edits before execution', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-noop-'));
    const targetFile = path.join(dir, 'game.html');
    await writeFile(targetFile, '<!doctype html><html><body></body></html>', 'utf-8');

    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: 'edit ok',
      })),
    };
    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
      artifactRepairGuard: {
        targetFile,
        attempts: 0,
        phase: 'initial_repair',
      },
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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

    const [blocked] = await engine.executeToolsWithHooks([
      {
        id: 'repair-comment-only',
        name: 'Edit',
        arguments: {
          file_path: targetFile,
          edits: [{
            old_text: '// CORGI PLATFORMER v3 — Full Game Engine',
            new_text: '// CORGI PLATFORMER v3.1 — Full Game Engine',
          }],
        },
      } as ToolCall,
    ]);

    expect(blocked.success).toBe(false);
    expect(blocked.error).toContain('only changes comments or banner text');
    expect(blocked.error).toContain('rewrite the full artifact with Write');
    expect(ctx.artifactRepairGuard?.patched).not.toBe(true);
    expect(toolExecutor.execute).not.toHaveBeenCalled();
  });

  it('blocks probe-style artifact repair edits before execution', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-probe-edit-'));
    const targetFile = path.join(dir, 'game.html');
    await writeFile(targetFile, '<!doctype html><html><body><script>function gameLoop() { update(); }</script></body></html>', 'utf-8');

    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: 'edit ok',
      })),
    };
    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
      artifactRepairGuard: {
        targetFile,
        attempts: 0,
        phase: 'read_then_patch',
      },
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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

    const [blocked] = await engine.executeToolsWithHooks([
      {
        id: 'repair-probe-edit',
        name: 'Edit',
        arguments: {
          file_path: targetFile,
          edits: [{
            old_text: 'function gameLoop()',
            new_text: '/* PROBE_GAMELOOP */ function gameLoop()',
          }],
        },
      } as ToolCall,
    ]);

    expect(blocked.success).toBe(false);
    expect(blocked.error).toContain('source probe');
    expect(toolExecutor.execute).not.toHaveBeenCalled();
  });

  it('blocks placeholder marker artifact repair edits before execution', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-placeholder-edit-'));
    const targetFile = path.join(dir, 'game.html');
    await writeFile(targetFile, `
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          window.__GAME_TEST__ = {
            start() { return {}; },
            snapshot() { return {}; },
            runSmokeTest() { return { passed: false, failures: ['needs repair'], checks: [] }; }
          };
        </script>
      </body>
      </html>
    `, 'utf-8');

    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: 'edit ok',
      })),
    };
    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
      artifactRepairGuard: {
        targetFile,
        attempts: 2,
        phase: 'targeted_repair',
      },
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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

    const [blocked] = await engine.executeToolsWithHooks([
      {
        id: 'repair-placeholder-marker-edit',
        name: 'Edit',
        arguments: {
          file_path: targetFile,
          edits: [{
            old_text: 'window.__GAME_TEST__ = {',
            new_text: 'window.__GAME_TEST__ = {\n            // PLACEHOLDER_MARKER_0',
          }],
        },
      } as ToolCall,
    ]);

    expect(blocked.success).toBe(false);
    expect(blocked.error).toContain('placeholder or probe markers');
    expect(ctx.artifactRepairGuard?.patched).not.toBe(true);
    expect(toolExecutor.execute).not.toHaveBeenCalled();
  });

  it('blocks comment-only adjunct artifact repair edits before execution', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-comment-adjunct-'));
    const targetFile = path.join(dir, 'game.html');
    await writeFile(targetFile, '<!doctype html><html><body><script>function updatePlayer() { player.x += 1; }</script></body></html>', 'utf-8');

    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: 'edit ok',
      })),
    };
    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
      artifactRepairGuard: {
        targetFile,
        attempts: 2,
        phase: 'targeted_repair',
      },
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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

    const [blocked] = await engine.executeToolsWithHooks([
      {
        id: 'repair-comment-adjunct-edit',
        name: 'Edit',
        arguments: {
          file_path: targetFile,
          edits: [{
            old_text: 'function updatePlayer() { player.x += 1; }',
            new_text: '// TODO: verify jump reachability\nfunction updatePlayer() { player.x += 1; }',
          }],
        },
      } as ToolCall,
    ]);

    expect(blocked.success).toBe(false);
    expect(blocked.error).toContain('only adds or changes comments');
    expect(toolExecutor.execute).not.toHaveBeenCalled();
  });

  it('blocks placeholder target writes during artifact repair before execution', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-placeholder-write-'));
    const targetFile = path.join(dir, 'game.html');
    await writeFile(targetFile, '<!doctype html><html><body><canvas id="game"></canvas></body></html>', 'utf-8');

    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: 'write ok',
      })),
    };
    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
      artifactRepairGuard: {
        targetFile,
        attempts: 1,
        phase: 'baseline_repair',
      },
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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

    const [blocked] = await engine.executeToolsWithHooks([
      {
        id: 'repair-placeholder-write',
        name: 'Write',
        arguments: {
          file_path: targetFile,
          content: 'PLACEHOLDER_READ_NEEDED',
        },
      } as ToolCall,
    ]);

    expect(blocked.success).toBe(false);
    expect(blocked.error).toContain('placeholder text');
    expect(ctx.artifactRepairGuard?.patched).not.toBe(true);
    expect(toolExecutor.execute).not.toHaveBeenCalled();
  });

  it('injects repair recovery context and forces reinference after repeated repair-guard blocks', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-recovery-'));
    const targetFile = path.join(dir, 'game.html');
    const validatorFile = path.join(dir, 'gameArtifactValidator.ts');
    await writeFile(targetFile, '<!doctype html><html><body></body></html>', 'utf-8');
    await writeFile(validatorFile, 'validator source', 'utf-8');

    const toolExecutor = {
      execute: vi.fn(async (name: string): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: `${name} ok`,
      })),
    };
    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
      artifactRepairGuard: {
        targetFile,
        attempts: 0,
        phase: 'initial_repair',
      },
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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

    const [firstBlocked] = await engine.executeToolsWithHooks([
      makeToolCall('repair-read-validator-1', validatorFile),
    ]);
    expect(firstBlocked.success).toBe(false);
    expect(ctx.turn.needsReinference).toBe(true);
    expect(contextAssembly.pushPersistentSystemContext).toHaveBeenCalledWith(
      expect.stringContaining('<artifact-repair-recovery>'),
    );

    ctx.turn.clearReinference();
    const [secondBlocked] = await engine.executeToolsWithHooks([
      makeToolCall('repair-read-validator-2', validatorFile),
    ]);
    expect(secondBlocked.success).toBe(false);
    expect(ctx.turn.needsReinference).toBe(true);
    // Route A: a non-target read stays blocked every time, with the same recovery
    // guidance — there is no blocked-tool counter that escalates the message.
    expect(contextAssembly.pushPersistentSystemContext).toHaveBeenLastCalledWith(
      expect.stringContaining('Your next action must be Edit, Append, or a complete Write on the target HTML file now'),
    );
    expect(toolExecutor.execute).not.toHaveBeenCalled();
  });

  it('finishes artifact repair immediately when a blocked source read is followed by successful revalidation', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-autofinish-'));
    const targetFile = path.join(dir, 'game.html');
    const validatorFile = path.join(dir, 'gameArtifactValidator.ts');
    await writeFile(targetFile, `
      <!doctype html>
      <html>
      <body>
        <canvas id="game" width="320" height="180" style="width: min(90vw, calc(90dvh * 16 / 9)); height: auto; aspect-ratio: 16 / 9; display: block; margin: 0 auto;"></canvas>
        <script>
          const canvas = document.getElementById('game');
          const ctx = canvas.getContext('2d');
          const state = { x: 0, score: 0 };
          function draw() {
            ctx.fillStyle = '#18251f';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#75d7a9';
            ctx.fillRect(28 + state.x, 118, 28, 34);
            ctx.fillStyle = '#f2bd4a';
            ctx.fillRect(0, 154, canvas.width, 10);
          }
          window.__GAME_META__ = {
            domain: 'game',
            subtype: 'arcade',
            controls: { ArrowRight: 'Move right', Space: 'Jump' },
            levels: [{ id: 0, name: 'Level 1' }],
            progressPlan: [{ input: 'ArrowRight', metric: 'playerX', expect: 'increase' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['platform_movement', 'jumping'],
              rewards: ['score_from_treats'],
              risks: ['fall_death'],
              levelsCovered: 1,
              allLevelsReachable: true,
              stateChanges: ['playerX', 'score']
            }
          };
          window.addEventListener('keydown', (event) => {
            if (event.code === 'ArrowRight' || event.key === 'ArrowRight') {
              state.x += 10;
              state.score += 1;
            }
          });
          window.__GAME_TEST__ = {
            start() { state.x = 0; state.score = 0; draw(); return { mode: 'playing' }; },
            reset() { state.x = 0; state.score = 0; draw(); return { mode: 'playing' }; },
            snapshot() { return { playerX: state.x, score: state.score, mode: 'playing' }; },
            step(input, frames = 1) {
              for (let i = 0; i < frames; i++) {
                if (input?.ArrowRight) {
                  state.x += 10;
                  state.score += 1;
                }
              }
              draw();
              return this.snapshot();
            },
            runSmokeTest() {
              this.start();
              this.step({ ArrowRight: true }, 2);
              return {
                passed: state.x > 0 && state.score > 0,
                checks: ['runtime smoke passed via interactive test contract'],
                failures: [],
                coverage: {
                  levelsPassed: 1,
                  totalLevels: 1,
                  allLevelsReachable: true,
                  mechanics: ['platform_movement', 'jumping'],
                  rewards: ['score_from_treats'],
                  risks: ['fall_death'],
                  stateChanges: ['playerX', 'score']
                }
              };
            }
          };
          draw();
        </script>
      </body>
      </html>
    `, 'utf-8');
    await writeFile(validatorFile, 'validator source', 'utf-8');

    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: 'read ok',
      })),
    };
    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
      artifactRepairGuard: {
        targetFile,
        attempts: 1,
        phase: 'baseline_repair',
      },
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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

    const [blocked] = await engine.executeToolsWithHooks([
      makeToolCall('repair-read-validator-pass', validatorFile),
    ]);

    expect(blocked.success).toBe(false);
    expect(ctx.artifactRepairGuard).toBeUndefined();
    expect(ctx.control.forceFinalResponseReason).toContain('artifact repair target already passes validation');
    expect(ctx.control.forceFinalResponsePrompt).toContain('force-final-response');
    expect(ctx.turn.needsReinference).toBe(false);
    expect(contextAssembly.pushPersistentSystemContext).not.toHaveBeenCalled();
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('<artifact-validation-passed kind="interactive_artifact">'),
    );
    expect(toolExecutor.execute).not.toHaveBeenCalled();
  });

  it('flags an ambiguous target Edit failure and pushes recovery guidance', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-edit-anchor-failure-'));
    const targetFile = path.join(dir, 'game.html');
    await writeFile(targetFile, '<!doctype html><html><body><script>function step(){} function step(){}</script></body></html>', 'utf-8');

    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => ({
        toolCallId: '',
        success: false,
        error: 'Edit #1/1 failed: found 2 occurrences. Use replace_all: true or provide more context.',
      })),
    };
    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
      artifactRepairGuard: {
        targetFile,
        attempts: 1,
        phase: 'baseline_repair',
      },
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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
      {
        id: 'repair-ambiguous-edit',
        name: 'Edit',
        arguments: {
          file_path: targetFile,
          edits: [{ old_text: 'function step()', new_text: 'function step(input)' }],
        },
      } as ToolCall,
    ]);

    expect(result.success).toBe(false);
    expect(ctx.turn.needsReinference).toBe(true);
    // Route A: the edit-anchor failure is still detected and surfaced, it just no
    // longer escalates guard counters or flips into a "targeted edit" mode.
    expect(result.metadata?.artifactRepairGuard?.editAnchorFailure).toBe(true);
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('<artifact-repair-edit-anchor-failed>'),
    );
    expect(contextAssembly.pushPersistentSystemContext).toHaveBeenCalledWith(
      expect.stringContaining('<artifact-repair-recovery>'),
    );
  });

  it('finishes artifact repair after a successful target read if the target already validates', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-target-read-pass-'));
    const targetFile = path.join(dir, 'game.html');
    await writeFile(targetFile, `
      <!doctype html>
      <html>
      <body>
        <canvas id="game" width="320" height="180" style="width: min(90vw, calc(90dvh * 16 / 9)); height: auto; aspect-ratio: 16 / 9; display: block; margin: 0 auto;"></canvas>
        <script>
          const canvas = document.getElementById('game');
          const ctx = canvas.getContext('2d');
          const state = { x: 0, score: 0 };
          function draw() {
            ctx.fillStyle = '#18251f';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#75d7a9';
            ctx.fillRect(28 + state.x, 118, 28, 34);
            ctx.fillStyle = '#f2bd4a';
            ctx.fillRect(0, 154, canvas.width, 10);
          }
          window.__GAME_META__ = {
            domain: 'game',
            subtype: 'runner',
            autoRun: true,
            forwardAxis: 'x',
            runSpeed: 8,
            controls: { ArrowRight: 'Move right', Space: 'Jump' },
            levels: [{ id: 0 }],
            obstacles: [{ id: 'pit-1', type: 'pit', position: 48, action: 'jump' }],
            progressPlan: [
              { input: 'ArrowRight', frames: 2, metric: 'distanceTraveled', expect: 'increase' },
              { input: 'Space', frames: 1, metric: 'obstaclesAvoided', expect: 'increase' }
            ],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['auto_run', 'jump_evade'],
              rewards: ['score_from_distance'],
              risks: ['pit_obstacle'],
              levelsCovered: 1,
              allLevelsReachable: true,
              stateChanges: ['distanceTraveled', 'obstaclesAvoided', 'pickupsCollected', 'score']
            }
          };
          window.__GAME_TEST__ = {
            start() {
              state.x = 0;
              state.score = 0;
              state.distanceTraveled = 0;
              state.obstaclesAvoided = 0;
              state.pickupsCollected = 0;
              state.gameOver = false;
              draw();
              return { mode: 'playing' };
            },
            reset() { return this.start(); },
            snapshot() {
              return {
                playerX: state.x,
                score: state.score,
                distanceTraveled: state.distanceTraveled,
                obstaclesAvoided: state.obstaclesAvoided,
                pickupsCollected: state.pickupsCollected,
                gameOver: state.gameOver,
                mode: 'playing'
              };
            },
            step(input, frames = 1) {
              for (let i = 0; i < frames; i++) {
                state.distanceTraveled += 8;
                state.x = state.distanceTraveled;
                state.score += 1;
                if (input?.ArrowRight) {
                  state.score += 1;
                }
                if (input?.Space || input?.ArrowUp || input?.jump) {
                  state.obstaclesAvoided += 1;
                }
                if (state.distanceTraveled >= 24 && state.pickupsCollected === 0) {
                  state.pickupsCollected = 1;
                }
              }
              draw();
              return this.snapshot();
            },
            runSmokeTest() {
              this.step({ ArrowRight: true }, 2);
              this.step({ Space: true }, 1);
              return {
                passed: state.distanceTraveled > 0 && state.obstaclesAvoided > 0 && state.score > 0,
                checks: ['runtime smoke passed via target read'],
                failures: [],
                coverage: {
                  levelsPassed: 1,
                  totalLevels: 1,
                  allLevelsReachable: true,
                  mechanics: ['auto_run', 'jump_evade'],
                  rewards: ['score_from_distance'],
                  risks: ['pit_obstacle'],
                  stateChanges: ['distanceTraveled', 'obstaclesAvoided', 'pickupsCollected', 'score']
                }
              };
            }
          };
          draw();
        </script>
      </body>
      </html>
    `, 'utf-8');

    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: await import('fs/promises').then((fs) => fs.readFile(targetFile, 'utf-8')),
      })),
    };
    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
      artifactRepairGuard: {
        targetFile,
        attempts: 0,
        phase: 'initial_repair',
      },
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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

    const [targetRead] = await engine.executeToolsWithHooks([
      makeToolCall('repair-read-target-pass', targetFile),
    ]);

    expect(targetRead.success).toBe(true);
    expect(ctx.artifactRepairGuard).toBeUndefined();
    expect(ctx.control.forceFinalResponseReason).toContain('artifact repair target already passes validation');
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('<artifact-validation-passed kind="interactive_artifact">'),
    );
    expect(contextAssembly.pushPersistentSystemContext).not.toHaveBeenCalled();
  });

  it('does not force-final playability repair just because the static contract validates', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-playability-no-final-'));
    const targetFile = path.join(dir, 'game.html');
    await writeFile(targetFile, `
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          const state = { x: 0, score: 0 };
          window.__GAME_META__ = {
            domain: 'game',
            subtype: 'runner',
            controls: { ArrowRight: 'Move right' },
            levels: [{ id: 0 }],
            progressPlan: [{ input: 'ArrowRight', metric: 'playerX', expect: 'increase' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['platform_movement'],
              rewards: ['score_from_treats'],
              risks: ['fall_death'],
              levelsCovered: 1,
              allAuthoredLevelsReachable: true,
              stateChanges: ['playerX', 'score']
            }
          };
          window.__GAME_TEST__ = {
            start() { state.x = 0; state.score = 0; return { mode: 'playing' }; },
            reset() { state.x = 0; state.score = 0; return { mode: 'playing' }; },
            snapshot() { return { playerX: state.x, score: state.score, mode: 'playing' }; },
            step(input, frames = 1) {
              for (let i = 0; i < frames; i++) {
                if (input?.ArrowRight) {
                  state.x += 8;
                  state.score += 1;
                }
              }
              return this.snapshot();
            },
            runSmokeTest() {
              this.start();
              this.step({ ArrowRight: true }, 2);
              return {
                passed: state.x > 0 && state.score > 0,
                checks: ['runtime smoke passed via target read'],
                failures: [],
                coverage: {
                  levelsPassed: 1,
                  totalLevels: 1,
                  allLevelsReachable: true,
                  mechanics: ['platform_movement'],
                  rewards: ['score_from_treats'],
                  risks: ['fall_death'],
                  stateChanges: ['playerX', 'score']
                }
              };
            }
          };
        </script>
      </body>
      </html>
    `, 'utf-8');

    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: await import('fs/promises').then((fs) => fs.readFile(targetFile, 'utf-8')),
      })),
    };
    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
      artifactRepairGuard: {
        targetFile,
        attempts: 0,
        phase: 'playability_repair',
      },
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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

    const [targetRead] = await engine.executeToolsWithHooks([
      makeToolCall('repair-read-target-playability-pass', targetFile),
    ]);

    expect(targetRead.success).toBe(true);
    expect(ctx.artifactRepairGuard).toMatchObject({
      targetFile,
      phase: 'playability_repair',
    });
    expect(ctx.control.forceFinalResponseReason).toBeUndefined();
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('<artifact-playability-repair-active>'),
    );
  });

  it('seeds artifact repair guard from the initial repair request before any write occurs', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-seed-'));
    const targetFile = path.join(dir, 'game.html');
    const validatorFile = path.join(dir, 'gameArtifactValidator.ts');
    await writeFile(targetFile, '<!doctype html><html><body></body></html>', 'utf-8');
    await writeFile(validatorFile, 'validator source', 'utf-8');

    const userMessage: Message = {
      id: 'user-repair',
      role: 'user',
      content: `修复 ${targetFile} 这个单文件 HTML 游戏。当前 validator 失败摘要：runSmokeTest 未通过，reachability step 没有让 progress 满足 increase。`,
      timestamp: Date.now(),
    };
    const toolExecutor = {
      execute: vi.fn(async (name: string): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: `${name} ok`,
      })),
    };
    const ctx = makeRuntimeContext({
      messages: [userMessage],
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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

    const [allowedRead] = await engine.executeToolsWithHooks([
      makeToolCall('initial-repair-read-target', targetFile),
    ]);
    expect(allowedRead.success).toBe(true);
    expect(ctx.artifactRepairGuard).toMatchObject({
      targetFile,
      attempts: 0,
      phase: 'initial_repair',
      patched: false,
    });
    expect(toolExecutor.execute).toHaveBeenCalledTimes(1);

    vi.mocked(toolExecutor.execute).mockClear();
    const [blockedValidatorRead] = await engine.executeToolsWithHooks([
      makeToolCall('initial-repair-read-validator', validatorFile),
    ]);
    expect(blockedValidatorRead.success).toBe(false);
    expect(blockedValidatorRead.error).toContain('Read is limited to the target artifact file during repair');
    expect(toolExecutor.execute).not.toHaveBeenCalled();
  });

  it('blocks repeating the same failed artifact repair Edit after rollback', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-repeat-patch-'));
    const targetFile = path.join(dir, 'game.html');
    await writeFile(targetFile, `
      <!doctype html>
      <html><body><canvas id="game"></canvas><script>
      window.__GAME_META__ = { domain: 'game', controls: { right: 'ArrowRight' }, levels: [{ id: 1 }], progressPlan: [{ input: 'ArrowRight', metric: 'progress', expect: 'increase' }] };
      window.__GAME_TEST__ = {
        start() { return {}; },
        snapshot() { return { progress: 0 }; },
        runSmokeTest() { return { passed: false, failures: ['still broken'], checks: [] }; }
      };
      </script></body></html>
    `, 'utf-8');

    const repeatedEdit: ToolCall = {
      id: 'repair-repeat-edit',
      name: 'Edit',
      arguments: {
        file_path: targetFile,
        edits: [{
          old_text: 'snapshot() { return { progress: 0 }; }',
          new_text: 'snapshot() { return { progress: 1 }; }',
        }],
      },
    } as ToolCall;

    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: 'should not run',
      })),
    };
    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
      artifactRepairGuard: {
        targetFile,
        attempts: 1,
        phase: 'baseline_repair',
        lastFailedPatchFingerprint: 'placeholder',
      },
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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

    const fingerprintSource = {
      name: repeatedEdit.name,
      arguments: repeatedEdit.arguments,
    } as ToolCall;
    const crypto = await import('crypto');
    ctx.artifactRepairGuard!.lastFailedPatchFingerprint = crypto
      .createHash('sha256')
      .update(JSON.stringify({
        name: fingerprintSource.name,
        path: targetFile,
        edits: [{
          oldText: 'snapshot() { return { progress: 0 }; }',
          newText: 'snapshot() { return { progress: 1 }; }',
        }],
      }))
      .digest('hex');

    const [result] = await engine.executeToolsWithHooks([repeatedEdit]);

    expect(result.success).toBe(false);
    expect(result.error).toContain('repeats the same target-file patch');
    expect(result.metadata?.artifactRepairGuard?.repeatedFailedPatch).toBe(true);
    expect(ctx.turn.needsReinference).toBe(true);
    expect(toolExecutor.execute).not.toHaveBeenCalled();
  });

  it('keeps rollback-state issue codes active after a failed artifact repair patch', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-rollback-issues-'));
    const targetFile = path.join(dir, 'game.html');
    await writeFile(targetFile, `
      <!doctype html>
      <html><body><canvas id="game"></canvas><script>
      const state = { progress: 0, score: 0 };
      window.__GAME_META__ = {
        domain: 'game',
        controls: { ArrowRight: 'Move right' },
        levels: [{ id: '1' }],
        progressPlan: [{ input: 'ArrowRight', metric: 'progress', expect: 'increase' }],
        qualityPlan: { actorReadable: true, mechanics: ['move'], rewards: ['score'], risks: ['timer'] }
      };
      window.__GAME_TEST__ = {
        start() { state.progress = 0; state.score = 0; },
        snapshot() { return { ...state }; },
        step(input, frames = 1) { if (input && input.ArrowRight) state.progress += frames; return this.snapshot(); },
        runSmokeTest() { return { passed: true, checks: ['registered'], failures: [], coverage: { mechanics: ['move'], rewards: ['score'], risks: [], stateChanges: ['progress'], levelsPassed: 1, totalLevels: 1, allLevelsReachable: true } }; }
      };
        start() { return { orphaned: true }; },
        runSmokeTest() { return { passed: true, checks: ['orphaned'], failures: [] }; }
      window.addEventListener('keydown', () => {});
      function gameLoop() { requestAnimationFrame(gameLoop); }
      gameLoop();
      </script></body></html>
    `, 'utf-8');

    const toolExecutor = {
      execute: vi.fn(async (_toolName: string, args: Record<string, unknown>): Promise<ToolResult> => {
        const edits = args.edits as Array<Record<string, unknown>>;
        const oldText = String(edits[0]?.old_text || '');
        const newText = String(edits[0]?.new_text || '');
        const fs = await import('fs/promises');
        const current = await fs.readFile(targetFile, 'utf-8');
        await fs.writeFile(targetFile, current.replace(oldText, newText), 'utf-8');
        return {
          toolCallId: '',
          success: true,
          output: 'write ok',
        };
      }),
    };
    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
      artifactRepairGuard: {
        targetFile,
        attempts: 1,
        phase: 'baseline_repair',
        activeIssueCodes: ['malformed_test_contract'],
      },
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
      getCurrentAttachments: vi.fn().mockReturnValue([]),
    };
    const engine = new ToolExecutionEngine(ctx);
    engine.setModules(contextAssembly as never, { emitTaskProgress: vi.fn() } as never, {
      setPlanMode: vi.fn(),
      isPlanMode: vi.fn().mockReturnValue(false),
      generateAutoContinuationPrompt: vi.fn().mockReturnValue('continue'),
    } as never);

    const [result] = await engine.executeToolsWithHooks([
      {
        id: 'repair-contract-still-fails',
        name: 'Edit',
        arguments: {
          file_path: targetFile,
          edits: [{
            old_text: 'window.__GAME_TEST__ = {',
            new_text: "window.__GAME_TEST__ = {\n  runSmokeTest() { return { passed: false, checks: [], failures: ['missing'] }; },",
          }],
        },
      } as ToolCall,
    ]);

    expect(result.success).toBe(false);
    expect(ctx.artifactRepairGuard?.activeIssueCodes).toContain('malformed_test_contract');
  });

  it('blocks artifact repair patches that miss the active validation issue scope', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-issue-scope-'));
    const targetFile = path.join(dir, 'game.html');
    await writeFile(targetFile, `
      <!doctype html>
      <html><body><canvas id="game"></canvas><script>
      window.__GAME_META__ = { domain: 'game', controls: { right: 'ArrowRight' }, levels: [{ id: 1 }], progressPlan: [{ input: 'ArrowRight', metric: 'progress', expect: 'increase' }] };
      window.__GAME_TEST__ = {
        start() { Game.start(); State.levelTransitionTimer = 0; return {}; },
        snapshot() { return { progress: 0 }; },
        step() { return this.snapshot(); },
        runSmokeTest() { return { passed: false, failures: ['coverage'], checks: [], coverage: { mechanics: ['enemy_present'] } }; }
      };
      </script></body></html>
    `, 'utf-8');

    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: 'should not run',
      })),
    };
    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
      artifactRepairGuard: {
        targetFile,
        attempts: 1,
        phase: 'baseline_repair',
        activeIssueCodes: ['coverage_without_runtime_evidence'],
      },
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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
      {
        id: 'repair-wrong-scope-edit',
        name: 'Edit',
        arguments: {
          file_path: targetFile,
          edits: [{
            old_text: 'start() { Game.start(); State.levelTransitionTimer = 0; return {}; }',
            new_text: 'start() { Game.start(); State.levelTransitionTimer = 0; State.mode = "playing"; return {}; }',
          }],
        },
      } as ToolCall,
    ]);

    expect(result.success).toBe(false);
    expect(result.error).toContain('coverage_without_runtime_evidence');
    expect(result.error).toContain('Do not spend a repair attempt changing unrelated start/reset/UI code');
    expect(toolExecutor.execute).not.toHaveBeenCalled();
    expect(contextAssembly.pushPersistentSystemContext).toHaveBeenCalledWith(
      expect.stringContaining('<artifact-repair-recovery>'),
    );
  });

  it('allows complete artifact Write for structural platformer gameplay repair', async () => {
    const oldChromePath = process.env.CHROME_PATH;
    const oldSystemChromePath = process.env.CODE_AGENT_SYSTEM_CHROME_PATH;
    process.env.CHROME_PATH = '';
    process.env.CODE_AGENT_SYSTEM_CHROME_PATH = '/not/a/real/chrome';

    try {
      const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-platformer-write-'));
      const targetFile = path.join(dir, 'game.html');
      await writeFile(targetFile, `
        <!doctype html>
        <html><body><canvas id="game"></canvas><script>
        window.__GAME_META__ = {
          domain: 'game',
          subtype: 'platformer',
          controls: { ArrowRight: 'Move right' }
        };
        window.__GAME_TEST__ = {
          start() { return { mode: 'playing' }; },
          snapshot() { return { playerX: 0, mode: 'playing' }; },
          runSmokeTest() { return { passed: false, checks: [], failures: ['missing gameplay'], coverage: {} }; }
        };
        </script></body></html>
      `, 'utf-8');

      const toolExecutor = {
        execute: vi.fn(async (): Promise<ToolResult> => ({
          toolCallId: '',
          success: true,
          output: 'written',
        })),
      };
      const ctx = makeRuntimeContext({
        toolExecutor: toolExecutor as never,
        workingDirectory: dir,
        artifactRepairGuard: {
          targetFile,
          attempts: 1,
          phase: 'targeted_repair',
          activeIssueCodes: ['gameplay_mechanics_without_runtime_evidence'],
        },
        antiPatternDetector: {
          trackToolFailure: vi.fn(),
          clearToolFailure: vi.fn(),
          trackDuplicateCall: vi.fn(),
          trackFileReread: vi.fn(),
          trackToolExecution: vi.fn().mockReturnValue(null),
          trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
          generateHardLimitError: vi.fn(),
        } as never,
      });
      const contextAssembly = {
        injectSystemMessage: vi.fn(),
        pushPersistentSystemContext: vi.fn(),
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
        makeWriteToolCall('repair-platformer-structural-write', targetFile),
      ]);

      expect(toolExecutor.execute).toHaveBeenCalled();
      expect(result.error || '').not.toContain('Write would replace the complete artifact during a targeted contract/metadata repair');
    } finally {
      if (typeof oldChromePath === 'undefined') delete process.env.CHROME_PATH;
      else process.env.CHROME_PATH = oldChromePath;
      if (typeof oldSystemChromePath === 'undefined') delete process.env.CODE_AGENT_SYSTEM_CHROME_PATH;
      else process.env.CODE_AGENT_SYSTEM_CHROME_PATH = oldSystemChromePath;
    }
  });

  it('blocks diagnostic logging patches during artifact repair', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-debug-log-'));
    const targetFile = path.join(dir, 'game.html');
    await writeFile(targetFile, `
      <!doctype html>
      <html><body><canvas id="game"></canvas><script>
      function update() {
        // Treat collection
        for (const t of treats) {
          if (t.collected) continue;
        }
      }
      window.__GAME_TEST__ = {
        start() { return {}; },
        snapshot() { return { score: 0 }; },
        step() { return this.snapshot(); },
        runSmokeTest() { return { passed: false, checks: [], failures: ['coverage'], coverage: {} }; }
      };
      </script></body></html>
    `, 'utf-8');

    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: 'should not run',
      })),
    };
    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
      artifactRepairGuard: {
        targetFile,
        attempts: 1,
        phase: 'baseline_repair',
        activeIssueCodes: ['coverage_without_runtime_evidence'],
      },
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
      getCurrentAttachments: vi.fn().mockReturnValue([]),
    };
    const engine = new ToolExecutionEngine(ctx);
    engine.setModules(contextAssembly as never, { emitTaskProgress: vi.fn() } as never, {
      setPlanMode: vi.fn(),
      isPlanMode: vi.fn().mockReturnValue(false),
      generateAutoContinuationPrompt: vi.fn().mockReturnValue('continue'),
    } as never);

    const [result] = await engine.executeToolsWithHooks([
      {
        id: 'repair-debug-log-edit',
        name: 'Edit',
        arguments: {
          file_path: targetFile,
          edits: [{
            old_text: 'if (t.collected) continue;',
            new_text: 'if (t.collected) continue; console.log("treat", t);',
          }],
        },
      } as ToolCall,
    ]);

    expect(result.success).toBe(false);
    expect(result.error).toContain('diagnostic logging');
    expect(toolExecutor.execute).not.toHaveBeenCalled();
  });

  it('blocks inner gameplay patches while malformed contract structure is still active', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-malformed-contract-scope-'));
    const targetFile = path.join(dir, 'game.html');
    await writeFile(targetFile, `
      <!doctype html>
      <html><body><canvas id="game"></canvas><script>
      function update() {}
      window.__GAME_TEST__ = {
        start() { return {}; },
        snapshot() { return { score: 0 }; },
        step() { return this.snapshot(); },
        runSmokeTest() {
          const checks = [];
          if (enemies.length > 0) checks.push('enemy risk present');
          return { passed: false, checks, failures: ['malformed'], coverage: {} };
        }
      };
        start() { return { orphaned: true }; },
        runSmokeTest() { return { passed: true, checks: ['orphaned'], failures: [] }; }
      </script></body></html>
    `, 'utf-8');

    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: 'should not run',
      })),
    };
    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
      artifactRepairGuard: {
        targetFile,
        attempts: 2,
        phase: 'targeted_repair',
        activeIssueCodes: ['malformed_test_contract'],
      },
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
      getCurrentAttachments: vi.fn().mockReturnValue([]),
    };
    const engine = new ToolExecutionEngine(ctx);
    engine.setModules(contextAssembly as never, { emitTaskProgress: vi.fn() } as never, {
      setPlanMode: vi.fn(),
      isPlanMode: vi.fn().mockReturnValue(false),
      generateAutoContinuationPrompt: vi.fn().mockReturnValue('continue'),
    } as never);

    const [result] = await engine.executeToolsWithHooks([
      {
        id: 'repair-malformed-inner-gameplay-edit',
        name: 'Edit',
        arguments: {
          file_path: targetFile,
          edits: [{
            old_text: "if (enemies.length > 0) checks.push('enemy risk present');",
            new_text: "if (this.step({ right: true }, 60).score > 0) checks.push('enemy risk changed score');",
          }],
        },
      } as ToolCall,
    ]);

    expect(result.success).toBe(false);
    expect(result.error).toContain('malformed_test_contract');
    expect(toolExecutor.execute).not.toHaveBeenCalled();
  });

  it('blocks single-method contract edits that also close the whole contract', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-method-contract-'));
    const targetFile = path.join(dir, 'game.html');
    await writeFile(targetFile, `
      <!doctype html>
      <html><body><canvas id="game"></canvas><script>
      window.__GAME_TEST__ = {
        start() { return {}; },
        snapshot() { return { score: 0 }; },
        step() { return this.snapshot(); },
        runSmokeTest() { return { passed: false, checks: [], failures: ['coverage'], coverage: {} }; }
      };
      </script></body></html>
    `, 'utf-8');

    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: 'should not run',
      })),
    };
    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
      artifactRepairGuard: {
        targetFile,
        attempts: 1,
        phase: 'baseline_repair',
        activeIssueCodes: ['coverage_without_runtime_evidence'],
      },
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
      getCurrentAttachments: vi.fn().mockReturnValue([]),
    };
    const engine = new ToolExecutionEngine(ctx);
    engine.setModules(contextAssembly as never, { emitTaskProgress: vi.fn() } as never, {
      setPlanMode: vi.fn(),
      isPlanMode: vi.fn().mockReturnValue(false),
      generateAutoContinuationPrompt: vi.fn().mockReturnValue('continue'),
    } as never);

    const [result] = await engine.executeToolsWithHooks([
      {
        id: 'repair-method-contract-fragment-edit',
        name: 'Edit',
        arguments: {
          file_path: targetFile,
          edits: [{
            old_text: 'runSmokeTest() { return { passed: false, checks: [], failures: [\'coverage\'], coverage: {} }; }',
            new_text: [
              'runSmokeTest() {',
              '  const before = this.snapshot();',
              '  const after = this.step({ right: true }, 60);',
              '  return { passed: after.score > before.score, checks: [], failures: [], coverage: {} };',
              '}',
              '};',
              'window.__INTERACTIVE_TEST__ = window.__GAME_TEST__;',
            ].join('\n'),
          }],
        },
      } as ToolCall,
    ]);

    expect(result.success).toBe(false);
    expect(result.error).toContain('single contract method');
    expect(toolExecutor.execute).not.toHaveBeenCalled();
  });

  it('fails repair validation when a target patch removes the interactive artifact contract', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-lost-contract-'));
    const targetFile = path.join(dir, 'game.html');
    await writeFile(targetFile, `
      <!doctype html>
      <html><body><canvas id="game"></canvas><script>
      window.__GAME_META__ = { domain: 'game', controls: { right: 'ArrowRight' }, levels: [{ id: 1 }], progressPlan: [{ input: 'ArrowRight', metric: 'progress', expect: 'increase' }] };
      window.addEventListener('keydown', () => {});
      window.__GAME_TEST__ = {
        start() { return {}; },
        snapshot() { return { progress: 0 }; },
        step() { return { progress: 1 }; },
        runSmokeTest() { return { passed: false, failures: ['broken'], checks: [] }; }
      };
      </script></body></html>
    `, 'utf-8');

    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => {
        await writeFile(targetFile, '<!doctype html><html><body>repair placeholder</body></html>', 'utf-8');
        return {
          toolCallId: '',
          success: true,
          output: `Updated file: ${targetFile}`,
        };
      }),
    };
    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
      artifactRepairGuard: {
        targetFile,
        attempts: 1,
        phase: 'baseline_repair',
      },
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
    });
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
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
      {
        id: 'repair-contract-removal',
        name: 'Edit',
        arguments: {
          file_path: targetFile,
          edits: [{
            old_text: 'window.__GAME_META__ = { domain: \'game\', controls: { right: \'ArrowRight\' }, levels: [{ id: 1 }], progressPlan: [{ input: \'ArrowRight\', metric: \'progress\', expect: \'increase\' }] };',
            new_text: 'const removedContract = true;',
          }],
        },
      } as ToolCall,
    ]);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Artifact validation failed');
    expect(result.error).toContain('lost_interactive_contract');
    expect(ctx.artifactRepairGuard).toMatchObject({
      targetFile,
      attempts: 1,
      phase: 'baseline_repair',
      patched: false,
    });
  });

  it('injects validation pass feedback after writing a runtime-testable game html artifact', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-runtime-game-pass-'));
    const filePath = path.join(dir, 'game.html');
    await writeFile(filePath, `
      <!doctype html>
      <html>
      <body>
        <canvas id="game" width="320" height="180" style="width: min(90vw, calc(90dvh * 16 / 9)); height: auto; aspect-ratio: 16 / 9; display: block; margin: 0 auto;"></canvas>
        <script>
          const canvas = document.getElementById('game');
          const ctx = canvas.getContext('2d');
          const state = { x: 0, score: 0 };
          function draw() {
            ctx.fillStyle = '#18251f';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#75d7a9';
            ctx.fillRect(28 + state.x, 118, 28, 34);
            ctx.fillStyle = '#f2bd4a';
            ctx.fillRect(0, 154, canvas.width, 10);
          }
          window.__GAME_META__ = {
            domain: 'game',
            controls: { right: 'ArrowRight' },
            levels: [{ id: '1' }],
            progressPlan: [{ input: 'ArrowRight', metric: 'progress', expect: 'increase' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['move'],
              rewards: ['score'],
              risks: ['timer']
            }
          };
          window.addEventListener('keydown', (event) => {
            if (event.code === 'ArrowRight' || event.key === 'ArrowRight') {
              state.x += 5;
              state.score += 1;
              draw();
            }
          });
          window.__GAME_TEST__ = {
            start: () => { window.__GAME_TEST__.reset('1'); },
            reset: () => { state.x = 0; state.score = 0; draw(); },
            snapshot: () => ({ ...state, progress: state.x }),
            step: (inputState, frames = 1) => {
              if (inputState && inputState.ArrowRight) {
                state.x += frames * 5;
                state.score += frames;
                draw();
              }
              return window.__GAME_TEST__.snapshot();
            },
            runSmokeTest: () => {
              window.__GAME_TEST__.start();
              const before = window.__GAME_TEST__.snapshot();
              const after = window.__GAME_TEST__.step({ ArrowRight: true }, 3);
              return {
                passed: after.x > before.x && after.score > before.score,
                checks: ['actor moved through shared step', 'reward changed through shared step'],
                failures: [],
                coverage: {
                  levelsPassed: 1,
                  totalLevels: 1,
                  allLevelsReachable: true,
                  mechanics: ['move'],
                  rewards: ['score'],
                  risks: ['timer'],
                  stateChanges: ['position', 'score']
                }
              };
            }
          };
          draw();
          function gameLoop() { draw(); requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `, 'utf-8');

    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: `Created file: ${filePath}`,
      })),
    };
    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
      goalMode: makePendingGoalMode(),
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
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
      makeWriteToolCall('tool-game-write-pass', filePath),
    ]);

    expect(result.success).toBe(true);
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('<artifact-validation-passed kind="interactive_artifact">'),
    );
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('runtime smoke passed via interactive test contract'),
    );
  });

  it('injects structural platformer repair guidance when gameplay mechanics validation fails', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-runtime-platformer-structural-fail-'));
    const filePath = path.join(dir, 'game.html');
    await writeFile(filePath, `
      <!doctype html>
      <html>
      <body>
        <canvas id="game" width="320" height="180" style="width: min(90vw, calc(90dvh * 16 / 9)); height: auto; aspect-ratio: 16 / 9; display: block; margin: 0 auto;"></canvas>
        <script>
          const canvas = document.getElementById('game');
          const ctx = canvas.getContext('2d');
          const state = { x: 0, score: 0 };
          function draw() {
            ctx.fillStyle = '#111827';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#70d6ff';
            ctx.fillRect(24 + state.x, 120, 24, 24);
          }
          window.__GAME_META__ = {
            domain: 'game',
            subtype: 'platformer',
            controls: { right: 'ArrowRight' },
            levels: [{ id: '1' }],
            progressPlan: [{ input: 'ArrowRight', frames: 4, metric: 'player.x', expect: 'increase' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['move'],
              rewards: ['score'],
              risks: ['enemy'],
              levelsCovered: 1,
              allLevelsReachable: true
            }
          };
          window.__GAME_TEST__ = {
            start() { state.x = 0; state.score = 0; draw(); },
            reset() { state.x = 0; state.score = 0; draw(); },
            snapshot() { return { player: { x: state.x }, score: state.score }; },
            step(input = {}, frames = 1) {
              for (let index = 0; index < frames; index += 1) {
                if (input.ArrowRight) {
                  state.x += 4;
                  state.score += 1;
                }
              }
              draw();
              return this.snapshot();
            },
            runSmokeTest() {
              this.reset();
              const before = this.snapshot();
              const after = this.step({ ArrowRight: true }, 4);
              return {
                passed: after.player.x > before.player.x,
                checks: ['move'],
                failures: [],
                coverage: {
                  levelsPassed: 1,
                  totalLevels: 1,
                  allLevelsReachable: true,
                  mechanics: ['move'],
                  rewards: ['score'],
                  risks: ['enemy'],
                  stateChanges: ['player.x', 'score']
                }
              };
            }
          };
          draw();
        </script>
      </body>
      </html>
    `, 'utf-8');

    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: `Created file: ${filePath}`,
      })),
    };
    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
      goalMode: makePendingGoalMode(),
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
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
      makeWriteToolCall('tool-game-write-platformer-structural-fail', filePath),
    ]);

    expect(result.success).toBe(false);
    expect(result.error).toContain('missing_gameplay_mechanics');
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('平台玩法修复必须把布局、碰撞、奖励、能力和 gate 路线一起修到可达'),
    );
    expect(ctx.artifactRepairGuard?.activeIssueCodes).toContain('missing_gameplay_mechanics');
  });

  it('defers game artifact validation for non-final append chunks', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-runtime-game-append-'));
    const filePath = path.join(dir, 'game.html');
    await writeFile(filePath, `
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          const player = { x: 0, y: 0 };
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
    `, 'utf-8');

    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: `Appended file: ${filePath}`,
      })),
    };
    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
      goalMode: makePendingGoalMode(),
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
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
      makeAppendToolCall('tool-game-append', filePath, false),
    ]);

    expect(result.success).toBe(true);
    expect(ctx.nudgeManager.trackModifiedFile).toHaveBeenCalledWith(filePath);
    expect(contextAssembly.injectSystemMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('<artifact-validation-failed kind="interactive_artifact">'),
    );
  });

  it('validates a complete game artifact even when the last append forgot final=true', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-runtime-game-append-complete-'));
    const filePath = path.join(dir, 'game.html');
    await writeFile(filePath, `
      <!doctype html>
      <html>
      <body>
        <canvas id="game"></canvas>
        <script>
          window.__GAME_META__ = {
            domain: 'game',
            controls: { right: 'ArrowRight' },
            levels: [{ id: '1' }],
            progressPlan: [{ input: 'ArrowRight', metric: 'progress', expect: 'increase' }]
          };
          const player = { x: 0, y: 0 };
          window.addEventListener('keydown', () => {});
          function gameLoop() { requestAnimationFrame(gameLoop); }
          gameLoop();
        </script>
      </body>
      </html>
    `, 'utf-8');

    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => ({
        toolCallId: '',
        success: true,
        output: `Appended file: ${filePath}`,
      })),
    };
    const ctx = makeRuntimeContext({
      toolExecutor: toolExecutor as never,
      workingDirectory: dir,
      goalMode: makePendingGoalMode(),
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn().mockReturnValue(null),
        trackReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
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
      makeAppendToolCall('tool-game-append-complete', filePath, false),
    ]);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Artifact validation failed');
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('<artifact-validation-failed kind="interactive_artifact">'),
    );
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('Append 没有设置 final=true'),
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
      control: ControlState.forTest({ runAbortController: controller } as never),
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
    ctx.control.markCancelled();
    controller.abort('run_cancelled');
    releaseExecution();

    const results = await resultsPromise;

    expect(results).toEqual([]);
    expect(ctx.telemetryAdapter?.onToolCallEnd).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.onEvent).mock.calls.some(([event]) => event.type === 'tool_call_end')).toBe(false);
  });
});

// ============================================================================
// #1 Kimi 借鉴 — 工具入参 repair 闸在「真引擎」里跑通（E2E 运行证据）
// 注册一条真实协议 schema（probe_tool 必填 target），驱动真 ToolExecutionEngine
// 的校验失败路径连续 3 次，验证前 2 次回灌 schema、第 3 次切终止指引。
// scoped 注册：probe_tool 唯一命名，其余工具名仍解析 undefined → 不影响本文件其他测试。
// ============================================================================
describe('ToolExecutionEngine — tool args repair gate fires in the real engine (Kimi #1)', () => {
  const schemas = new Map<string, never>();
  beforeAll(() => {
    setProtocolToolRegistryPort({
      register: (s: { name: string }) => { schemas.set(s.name, s as never); },
      unregister: (n: string) => schemas.delete(n),
      has: (n: string) => schemas.has(n),
      getSchemas: () => [...schemas.values()],
      resolve: async () => { throw new Error('unused in this test'); },
    } as never);
    schemas.set('probe_tool', {
      name: 'probe_tool',
      description: 'test probe tool requiring target',
      inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
      category: 'multiagent',
      permissionLevel: 'read',
      readOnly: true,
    } as never);
  });
  afterAll(() => {
    // 还原成空 port，避免影响后续 describe
    setProtocolToolRegistryPort({
      register: () => {}, unregister: () => false, has: () => false,
      getSchemas: () => [], resolve: async () => { throw new Error('reset'); },
    } as never);
  });

  it('switches schema-repair → terminal directive after the attempt cap', async () => {
    const ctx = makeRuntimeContext();
    const contextAssembly = {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
      getCurrentAttachments: vi.fn().mockReturnValue([]),
    };
    const engine = new ToolExecutionEngine(ctx);
    engine.setModules(
      contextAssembly as never,
      { emitTaskProgress: vi.fn() } as never,
      { setPlanMode: vi.fn(), isPlanMode: () => false, generateAutoContinuationPrompt: () => 'continue' } as never,
    );

    // probe_tool 缺必填 target → 真引擎校验失败，连续 3 次（上限 2）
    const call = (id: string) => ({ id, name: 'probe_tool', arguments: {} });
    const r1 = await engine.executeSingleTool(call('p1') as never, 0, 1, false);
    const r2 = await engine.executeSingleTool(call('p2') as never, 0, 1, false);
    const r3 = await engine.executeSingleTool(call('p3') as never, 0, 1, false);

    expect(r1.metadata?.repairExhausted).toBe(false);
    expect(r2.metadata?.repairExhausted).toBe(false);
    expect(r3.metadata?.repairExhausted).toBe(true);
    expect(r3.metadata?.repairAttempt).toBe(3);

    const injected = contextAssembly.injectSystemMessage.mock.calls.map((c) => c[0] as string);
    expect(injected[0]).toContain('校验失败');
    expect(injected[1]).toContain('校验失败');
    expect(injected[2]).toContain('tool-args-repair-exhausted');
    expect(injected[2]).not.toContain('完整参数 schema');
  });
});
