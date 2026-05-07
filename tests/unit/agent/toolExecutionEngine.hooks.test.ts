import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall, ToolResult } from '../../../src/shared/contract';
import { ToolExecutionEngine } from '../../../src/main/agent/runtime/toolExecutionEngine';
import type { RuntimeContext } from '../../../src/main/agent/runtime/runtimeContext';
import { fileReadTracker } from '../../../src/main/tools/fileReadTracker';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import type { Message } from '../../../src/shared/contract';

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
      <canvas id="game" width="320" height="180" style="width: 100%; max-width: 320px; height: auto; aspect-ratio: 16 / 9;"></canvas>
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
    recentToolFingerprints: [],
    stagnationWarningEmitted: false,
    antiScrapingHitsInRun: 0,
    effortLevel: 'medium' as never,
    thinkingStepCount: 0,
    interactionMode: 'cli' as never,
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
    autoCompressThreshold: 0.8,
    contextBudgetRatio: 0,
    genNum: 1,
    initialSystemPromptLength: 0,
    ...overrides,
  };
}

function makeMessageProcessorDeps(ctx: RuntimeContext) {
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
    const { MessageProcessor } = await import('../../../src/main/agent/runtime/messageProcessor');
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
    expect(ctx.forceFinalResponseReason).toContain('连续只读操作达到硬阈值');
    expect(ctx.forceFinalResponsePrompt).toContain('force-final-response');
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
        targetReadCount: 0,
        targetRangedReadCount: 0,
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
        targetReadCount: 1,
        targetRangedReadCount: 0,
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
        targetReadCount: 1,
        targetRangedReadCount: 1,
        patched: false,
        blockedToolCount: 4,
        preferTargetedEdit: true,
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
        targetReadCount: 1,
        targetRangedReadCount: 1,
        blockedToolCount: 4,
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
        targetReadCount: 1,
        targetRangedReadCount: 1,
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
      runAbortController: controller,
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
          const state = { x: 0, score: 0 };
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
    expect(third.metadata?.artifactValidation).toMatchObject({
      failed: true,
      attempts: 3,
      phase: 'read_then_patch',
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
    expect(injectedMessages).toEqual(expect.arrayContaining([
      expect.stringContaining('attempts: 3'),
      expect.stringContaining('repair phase: read_then_patch'),
      expect.stringContaining('最多只允许再 Read 一次这个目标文件'),
      expect.stringContaining('Repair 权限已经收窄到目标文件和验证命令'),
      expect.stringContaining('直接对这个文件做局部 Edit'),
      expect.stringContaining('enemy_present'),
      expect.stringContaining('不要重写整页'),
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

    ctx.needsReinference = false;
    vi.mocked(toolExecutor.execute).mockClear();
    const [allowedRead] = await engine.executeToolsWithHooks([
      makeToolCall('repair-read-target', targetFile),
    ]);
    expect(allowedRead.success).toBe(true);
    expect(toolExecutor.execute).toHaveBeenCalledTimes(1);

    ctx.needsReinference = false;
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

    ctx.needsReinference = false;
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
        arguments: { command: 'sed -n "1,200p" src/main/agent/runtime/gameArtifactValidator.ts' },
      },
    ]);
    expect(blockedValidatorSourceBash.success).toBe(false);
    expect(blockedValidatorSourceBash.error).toContain('Bash verification is only available after you patch the target artifact');
    expect(toolExecutor.execute).not.toHaveBeenCalled();

    ctx.needsReinference = false;
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

    ctx.needsReinference = false;
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
    ctx.needsReinference = false;
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
    ctx.needsReinference = false;
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
        targetReadCount: 1,
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
    expect(blocked.error).toContain('one ranged Read around the contract or metadata block');
    expect(ctx.artifactRepairGuard?.noOpPatchCount).toBe(1);
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
        targetReadCount: 1,
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
    expect(ctx.artifactRepairGuard?.noOpPatchCount).toBe(1);
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
        targetReadCount: 1,
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
    expect(ctx.artifactRepairGuard?.noOpPatchCount).toBe(1);
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
        targetReadCount: 1,
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
    expect(ctx.artifactRepairGuard?.noOpPatchCount).toBe(1);
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
        targetReadCount: 1,
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
    expect(ctx.artifactRepairGuard?.noOpPatchCount).toBe(1);
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
    expect(ctx.needsReinference).toBe(true);
    expect(ctx.artifactRepairGuard?.blockedToolCount).toBe(2);
    expect(ctx.artifactRepairGuard?.noOpPatchCount).toBeUndefined();
    expect(contextAssembly.pushPersistentSystemContext).toHaveBeenCalledWith(
      expect.stringContaining('<artifact-repair-recovery>'),
    );

    ctx.needsReinference = false;
    const [secondBlocked] = await engine.executeToolsWithHooks([
      makeToolCall('repair-read-validator-2', validatorFile),
    ]);
    expect(secondBlocked.success).toBe(false);
    expect(ctx.needsReinference).toBe(true);
    expect(ctx.artifactRepairGuard?.blockedToolCount).toBe(3);
    expect(contextAssembly.pushPersistentSystemContext).toHaveBeenLastCalledWith(
      expect.stringContaining('Your next action must be Edit or Append on the target HTML file now'),
    );
    expect(contextAssembly.pushPersistentSystemContext).toHaveBeenLastCalledWith(
      expect.stringContaining('duplicate orphaned `start/reset/snapshot/step/runSmokeTest` methods'),
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
        <canvas id="game" width="320" height="180" style="width: 100%; max-width: 320px; height: auto; aspect-ratio: 16 / 9;"></canvas>
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
    expect(ctx.forceFinalResponseReason).toContain('artifact repair target already passes validation');
    expect(ctx.forceFinalResponsePrompt).toContain('force-final-response');
    expect(ctx.needsReinference).toBe(false);
    expect(contextAssembly.pushPersistentSystemContext).not.toHaveBeenCalled();
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('<artifact-validation-passed kind="interactive_artifact">'),
    );
    expect(toolExecutor.execute).not.toHaveBeenCalled();
  });

  it('keeps artifact repair in targeted edit mode after an ambiguous target Edit failure', async () => {
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
        targetReadCount: 1,
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
    expect(ctx.needsReinference).toBe(true);
    expect(ctx.artifactRepairGuard?.noOpPatchCount).toBeUndefined();
    expect(ctx.artifactRepairGuard?.editAnchorFailureCount).toBe(1);
    expect(ctx.artifactRepairGuard?.preferTargetedEdit).toBe(true);
    expect(ctx.artifactRepairGuard?.blockedToolCount).toBe(2);
    expect(result.metadata?.artifactRepairGuard?.editAnchorFailure).toBe(true);
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('<artifact-repair-edit-anchor-failed>'),
    );
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('Do not use Write to replace the complete target HTML just because an Edit anchor was ambiguous.'),
    );
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('replace the enclosing `window.__GAME_TEST__ = { ... }` block'),
    );
    expect(contextAssembly.pushPersistentSystemContext).toHaveBeenCalledWith(
      expect.stringContaining('<artifact-repair-recovery>'),
    );
    expect(contextAssembly.pushPersistentSystemContext).toHaveBeenCalledWith(
      expect.stringContaining('replace a larger unique region'),
    );
    expect(contextAssembly.pushPersistentSystemContext).toHaveBeenCalledWith(
      expect.stringContaining('For coverage_without_runtime_evidence'),
    );
  });

  it('finishes artifact repair after a successful target read if the target already validates', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-target-read-pass-'));
    const targetFile = path.join(dir, 'game.html');
    await writeFile(targetFile, `
      <!doctype html>
      <html>
      <body>
        <canvas id="game" width="320" height="180" style="width: 100%; max-width: 320px; height: auto; aspect-ratio: 16 / 9;"></canvas>
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
            controls: { ArrowRight: 'Move right' },
            levels: [{ id: 0 }],
            progressPlan: [{ input: 'ArrowRight', metric: 'playerX', expect: 'increase' }],
            qualityPlan: {
              actorReadable: true,
              mechanics: ['platform_movement'],
              rewards: ['score_from_treats'],
              risks: ['fall_death'],
              levelsCovered: 1,
              allLevelsReachable: true,
              stateChanges: ['playerX', 'score']
            }
          };
          window.__GAME_TEST__ = {
            start() { state.x = 0; state.score = 0; draw(); return { mode: 'playing' }; },
            reset() { state.x = 0; state.score = 0; draw(); return { mode: 'playing' }; },
            snapshot() { return { playerX: state.x, score: state.score, mode: 'playing' }; },
            step(input, frames = 1) {
              for (let i = 0; i < frames; i++) {
                if (input?.ArrowRight) {
                  state.x += 8;
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
    expect(ctx.forceFinalResponseReason).toContain('artifact repair target already passes validation');
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
      targetReadCount: 1,
    });
    expect(ctx.forceFinalResponseReason).toBeUndefined();
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
      targetReadCount: 1,
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

  it('exhausts target-file read budget during artifact repair and then forces patching', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-read-budget-'));
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
        blockedToolCount: 1,
        targetReadCount: 0,
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

    const [allowedRead] = await engine.executeToolsWithHooks([
      makeToolCall('repair-read-target-1', targetFile),
    ]);
    expect(allowedRead.success).toBe(true);
    expect(ctx.artifactRepairGuard?.targetReadCount).toBe(1);
    expect(toolExecutor.execute).toHaveBeenCalledTimes(1);

    vi.mocked(toolExecutor.execute).mockClear();
    const [blockedRead] = await engine.executeToolsWithHooks([
      makeToolCall('repair-read-target-2', targetFile),
    ]);
    expect(blockedRead.success).toBe(false);
    expect(blockedRead.error).toContain('Target-file read budget is exhausted');
    expect(blockedRead.error).toContain('ranged target read');
    expect(ctx.artifactRepairGuard?.blockedToolCount).toBe(2);
    expect(ctx.needsReinference).toBe(true);
    expect(toolExecutor.execute).not.toHaveBeenCalled();
  });

  it('allows only one ranged target-file read after artifact repair full-read budget is exhausted', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-ranged-read-'));
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
        phase: 'read_then_patch',
        targetReadCount: 1,
        blockedToolCount: 2,
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

    const [allowedRangeRead] = await engine.executeToolsWithHooks([
      {
        id: 'repair-read-target-range',
        name: 'Read',
        arguments: {
          file_path: targetFile,
          offset: 820,
          limit: 120,
        },
      } as ToolCall,
    ]);

    expect(allowedRangeRead.success).toBe(true);
    expect(ctx.artifactRepairGuard?.targetReadCount).toBe(1);
    expect(ctx.artifactRepairGuard?.targetRangedReadCount).toBe(1);
    expect(toolExecutor.execute).toHaveBeenCalledTimes(1);

    vi.mocked(toolExecutor.execute).mockClear();
    const [blockedSecondRangeRead] = await engine.executeToolsWithHooks([
      {
        id: 'repair-read-target-range-2',
        name: 'Read',
        arguments: {
          file_path: targetFile,
          offset: 960,
          limit: 120,
        },
      } as ToolCall,
    ]);

    expect(blockedSecondRangeRead.success).toBe(false);
    expect(blockedSecondRangeRead.error).toContain('Target-file ranged read budget is exhausted');
    expect(blockedSecondRangeRead.error).toContain('patch the target file now');
    expect(blockedSecondRangeRead.error).toContain('Do not read level definitions or validator code');
    expect(blockedSecondRangeRead.error).toContain('remove any duplicate orphaned contract methods');
    expect(toolExecutor.execute).not.toHaveBeenCalled();
  });

  it('counts embedded lines target-file reads against the ranged read budget', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-lines-read-'));
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
        phase: 'read_then_patch',
        targetReadCount: 1,
        blockedToolCount: 2,
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

    const [allowedLinesRead] = await engine.executeToolsWithHooks([
      {
        id: 'repair-read-target-lines',
        name: 'Read',
        arguments: {
          file_path: `${targetFile} lines 820-940`,
        },
      } as ToolCall,
    ]);

    expect(allowedLinesRead.success).toBe(true);
    expect(ctx.artifactRepairGuard?.targetReadCount).toBe(1);
    expect(ctx.artifactRepairGuard?.targetRangedReadCount).toBe(1);
    expect(toolExecutor.execute).toHaveBeenCalledTimes(1);

    vi.mocked(toolExecutor.execute).mockClear();
    const [blockedSecondLinesRead] = await engine.executeToolsWithHooks([
      {
        id: 'repair-read-target-lines-2',
        name: 'Read',
        arguments: {
          file_path: `${targetFile} lines 940-1080`,
        },
      } as ToolCall,
    ]);

    expect(blockedSecondLinesRead.success).toBe(false);
    expect(blockedSecondLinesRead.error).toContain('Target-file ranged read budget is exhausted');
    expect(toolExecutor.execute).not.toHaveBeenCalled();
  });

  it('allows a second ranged target-file read for coverage evidence repairs', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-coverage-ranged-read-'));
    const targetFile = path.join(dir, 'game.html');
    await writeFile(targetFile, [
      '<!doctype html><html><body><script>',
      ...Array.from({ length: 40 }, (_, index) => `const filler${index} = ${index};`),
      'const State = { abilities: { dash: false }, collectedTreats: 0 };',
      'function update() {',
      '  for (const t of treats) {',
      '    if (t.ability) State.abilities[t.ability] = true;',
      '  }',
      '}',
      'window.__GAME_TEST__ = {',
      '  step(input, frames) { for (let i = 0; i < frames; i += 1) update(); return this.snapshot(); },',
      '  snapshot() { return { abilities: { ...State.abilities }, collectedTreats: State.collectedTreats }; },',
      '  runSmokeTest() { return { passed: false, failures: [], coverage: {} }; }',
      '};',
      '</script></body></html>',
    ].join('\n'), 'utf-8');

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
        targetReadCount: 1,
        targetRangedReadCount: 1,
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

    const [allowedSecondRangeRead] = await engine.executeToolsWithHooks([
      {
        id: 'repair-coverage-read-target-range-2',
        name: 'Read',
        arguments: {
          file_path: targetFile,
          offset: 42,
          limit: 20,
        },
      } as ToolCall,
    ]);

    expect(allowedSecondRangeRead.success).toBe(true);
    expect(ctx.artifactRepairGuard?.targetRangedReadCount).toBe(2);
    expect(toolExecutor.execute).toHaveBeenCalledTimes(1);

    vi.mocked(toolExecutor.execute).mockClear();
    const [blockedThirdRangeRead] = await engine.executeToolsWithHooks([
      {
        id: 'repair-coverage-read-target-range-3',
        name: 'Read',
        arguments: {
          file_path: targetFile,
          offset: 70,
          limit: 100,
        },
      } as ToolCall,
    ]);

    expect(blockedThirdRangeRead.success).toBe(false);
    expect(blockedThirdRangeRead.error).toContain('Target-file ranged read budget is exhausted');
    expect(toolExecutor.execute).not.toHaveBeenCalled();
  });

  it('blocks unrelated ranged target-file reads during coverage evidence repair', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-unrelated-ranged-read-'));
    const targetFile = path.join(dir, 'game.html');
    await writeFile(targetFile, [
      '<!doctype html><html><body><script>',
      'const title = "Corgi Platformer";',
      'const State = {',
      '  mode: "menu", // menu | playing | won | levelComplete',
      '  abilities: { dash: false },',
      '};',
      'const Player = {',
      '  update(dt, platforms) {',
      '    for (const p of platforms) {',
      '      if (this.overlaps(p)) this.y = p.y;',
      '    }',
      '  },',
      '  overlaps(other) { return Boolean(other); },',
      '};',
      ...Array.from({ length: 80 }, (_, index) => `const headerFiller${index} = ${index};`),
      'function update() {',
      '  for (const t of treats) {',
      '    if (t.ability) State.abilities[t.ability] = true;',
      '  }',
      '}',
      'window.__GAME_TEST__ = {',
      '  step(input, frames) { for (let i = 0; i < frames; i += 1) update(); return this.snapshot(); },',
      '  snapshot() { return { abilities: { ...State.abilities }, collectedTreats: State.collectedTreats }; },',
      '  runSmokeTest() { return { passed: false, failures: [], coverage: {} }; }',
      '};',
      '</script></body></html>',
    ].join('\n'), 'utf-8');

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
        targetReadCount: 1,
        targetRangedReadCount: 1,
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

    const [blockedHeaderRead] = await engine.executeToolsWithHooks([
      {
        id: 'repair-coverage-read-target-header',
        name: 'Read',
        arguments: {
          file_path: targetFile,
          offset: 1,
          limit: 5,
        },
      } as ToolCall,
    ]);

    expect(blockedHeaderRead.success).toBe(false);
    expect(blockedHeaderRead.error).toContain('does not overlap the active validation failure scope');
    expect(blockedHeaderRead.error).toContain('runtime update / collision evidence');
    expect(blockedHeaderRead.error).toContain('patch the target file with Edit or Append');
    expect(ctx.artifactRepairGuard?.targetRangedReadCount).toBe(1);
    expect(toolExecutor.execute).not.toHaveBeenCalled();
  });

  it('blocks header reads after a contract read even when early object methods look executable', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-header-method-read-'));
    const targetFile = path.join(dir, 'game.html');
    await writeFile(targetFile, [
      '<!doctype html><html><body><script>',
      'const State = {',
      '  mode: "menu", // menu | playing | won | levelComplete',
      '  abilities: { dash: false },',
      '};',
      'const Player = {',
      '  update(dt, platforms) {',
      '    for (const p of platforms) {',
      '      if (this.overlaps(p)) this.y = p.y;',
      '    }',
      '  },',
      '  overlaps(other) { return Boolean(other); },',
      '};',
      ...Array.from({ length: 120 }, (_, index) => `const headerFiller${index} = ${index};`),
      'function update() {',
      '  for (const t of treats) {',
      '    if (Player.overlaps(t)) {',
      '      t.collected = true;',
      '      State.score += 10;',
      '      if (t.ability) State.abilities[t.ability] = true;',
      '    }',
      '  }',
      '}',
      'window.__GAME_TEST__ = {',
      '  step(input, frames) { for (let i = 0; i < frames; i += 1) update(); return this.snapshot(); },',
      '  snapshot() { return { abilities: { ...State.abilities }, score: State.score }; },',
      '  runSmokeTest() { return { passed: false, failures: [], coverage: {} }; }',
      '};',
      '</script></body></html>',
    ].join('\n'), 'utf-8');

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
        targetReadCount: 1,
        targetRangedReadCount: 1,
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

    const [blockedHeaderRead] = await engine.executeToolsWithHooks([
      {
        id: 'repair-coverage-read-target-header-after-contract',
        name: 'Read',
        arguments: {
          file_path: targetFile,
          offset: 1,
          limit: 100,
        },
      } as ToolCall,
    ]);

    expect(blockedHeaderRead.success).toBe(false);
    expect(blockedHeaderRead.error).toContain('does not overlap the active validation failure scope');
    expect(blockedHeaderRead.error).toContain('runtime update / collision evidence');
    expect(ctx.artifactRepairGuard?.targetRangedReadCount).toBe(1);
    expect(toolExecutor.execute).not.toHaveBeenCalled();

    const [allowedRuntimeRead] = await engine.executeToolsWithHooks([
      {
        id: 'repair-coverage-read-runtime-after-blocked-header',
        name: 'Read',
        arguments: {
          file_path: targetFile,
          offset: 130,
          limit: 40,
        },
      } as ToolCall,
    ]);

    expect(allowedRuntimeRead.success).toBe(true);
    expect(ctx.artifactRepairGuard?.targetRangedReadCount).toBe(2);
    expect(toolExecutor.execute).toHaveBeenCalledTimes(1);
  });

  it('does not spend the second coverage ranged read on static level definitions', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-static-level-read-'));
    const targetFile = path.join(dir, 'game.html');
    await writeFile(targetFile, [
      '<!doctype html><html><body><script>',
      ...Array.from({ length: 80 }, (_, index) => `const headerFiller${index} = ${index};`),
      'const Levels = [{',
      '  name: "Green Meadow",',
      '  treats: [{ x: 230, y: 190, ability: "doubleJump" }],',
      '  enemies: [{ x: 360, y: 370 }],',
      '  door: { x: 740, y: 228 }',
      '}];',
      ...Array.from({ length: 120 }, (_, index) => `const midFiller${index} = ${index};`),
      'function update() {',
      '  for (const t of treats) {',
      '    if (Player.overlaps(t)) {',
      '      t.collected = true;',
      '      State.score += 10;',
      '      if (t.ability) State.abilities[t.ability] = true;',
      '    }',
      '  }',
      '}',
      'window.__GAME_TEST__ = {',
      '  step(input, frames) { for (let i = 0; i < frames; i += 1) update(); return this.snapshot(); },',
      '  snapshot() { return { abilities: { ...State.abilities }, score: State.score }; },',
      '  runSmokeTest() { return { passed: false, failures: [], coverage: {} }; }',
      '};',
      '</script></body></html>',
    ].join('\n'), 'utf-8');

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
        targetReadCount: 1,
        targetRangedReadCount: 1,
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

    const [blockedLevelRead] = await engine.executeToolsWithHooks([
      {
        id: 'repair-coverage-static-level-read',
        name: 'Read',
        arguments: {
          file_path: targetFile,
          offset: 82,
          limit: 20,
        },
      } as ToolCall,
    ]);

    expect(blockedLevelRead.success).toBe(false);
    expect(blockedLevelRead.error).toContain('does not overlap the active validation failure scope');
    expect(blockedLevelRead.error).toContain('runtime update / collision evidence');
    expect(ctx.artifactRepairGuard?.targetRangedReadCount).toBe(1);
    expect(toolExecutor.execute).not.toHaveBeenCalled();
  });

  it('blocks static level reads without starving a later runtime read in the same repair turn', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-read-priority-'));
    const targetFile = path.join(dir, 'game.html');
    await writeFile(targetFile, [
      '<!doctype html><html><body><script>',
      ...Array.from({ length: 80 }, (_, index) => `const headerFiller${index} = ${index};`),
      'const Levels = [{',
      '  name: "Green Meadow",',
      '  treats: [{ x: 230, y: 190, ability: "doubleJump" }],',
      '  enemies: [{ x: 360, y: 370 }],',
      '  door: { x: 740, y: 228 }',
      '}];',
      ...Array.from({ length: 120 }, (_, index) => `const midFiller${index} = ${index};`),
      'function update() {',
      '  for (const t of treats) {',
      '    if (Player.overlaps(t)) {',
      '      t.collected = true;',
      '      State.score += 10;',
      '      if (t.ability) State.abilities[t.ability] = true;',
      '    }',
      '  }',
      '}',
      'window.__GAME_TEST__ = {',
      '  step(input, frames) { for (let i = 0; i < frames; i += 1) update(); return this.snapshot(); },',
      '  snapshot() { return { abilities: { ...State.abilities }, score: State.score }; },',
      '  runSmokeTest() { return { passed: false, failures: [], coverage: {} }; }',
      '};',
      '</script></body></html>',
    ].join('\n'), 'utf-8');

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
        targetReadCount: 1,
        targetRangedReadCount: 0,
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

    const results = await engine.executeToolsWithHooks([
      {
        id: 'repair-contract-read',
        name: 'Read',
        arguments: {
          file_path: targetFile,
          offset: 218,
          limit: 30,
        },
      } as ToolCall,
      {
        id: 'repair-static-level-read',
        name: 'Read',
        arguments: {
          file_path: targetFile,
          offset: 82,
          limit: 20,
        },
      } as ToolCall,
      {
        id: 'repair-runtime-read',
        name: 'Read',
        arguments: {
          file_path: targetFile,
          offset: 202,
          limit: 30,
        },
      } as ToolCall,
    ]);

    expect(results).toHaveLength(3);
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(false);
    expect(results[1].error).toContain('does not overlap the active validation failure scope');
    expect(results[2].success).toBe(true);
    expect(ctx.artifactRepairGuard?.targetRangedReadCount).toBe(2);
    expect(ctx.artifactRepairGuard?.preferTargetedEdit).toBe(true);
    expect(ctx.artifactRepairGuard?.noOpPatchCount).toBe(1);
    expect(toolExecutor.execute).toHaveBeenCalledTimes(2);
  });

  it('keeps repair read budget exhausted after failed artifact validation', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-budget-carry-'));
    const targetFile = path.join(dir, 'game.html');
    const originalContent = `
      <!doctype html>
      <html><body><canvas id="game"></canvas><script>
      window.__GAME_META__ = { domain: 'game', controls: { right: 'ArrowRight' }, levels: [{ id: 1 }], progressPlan: [{ input: 'ArrowRight', metric: 'progress', expect: 'increase' }] };
      window.__GAME_TEST__ = {
        start() { return {}; },
        snapshot() { return { progress: 0 }; },
        runSmokeTest() { return { passed: false, failures: ['still broken'], checks: [] }; }
      };
      </script></body></html>
    `;
    await writeFile(targetFile, originalContent, 'utf-8');

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
        attempts: 0,
        phase: 'initial_repair',
        targetReadCount: 1,
        blockedToolCount: 2,
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
        id: 'repair-real-edit-still-fails',
        name: 'Edit',
        arguments: {
          file_path: targetFile,
          edits: [{
            old_text: 'snapshot() { return { progress: 0 }; }',
            new_text: 'snapshot() { return { progress: 1 }; }',
          }],
        },
      } as ToolCall,
    ]);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Artifact validation failed');
    expect(ctx.artifactRepairGuard).toMatchObject({
      targetFile,
      targetReadCount: 1,
      blockedToolCount: 2,
      noOpPatchCount: 1,
      patched: false,
    });
    expect(result.metadata).toMatchObject({
      artifactRepairRollback: {
        attempted: true,
        applied: true,
        targetFile,
      },
    });
    expect(result.error).toContain('rolled back');
    expect(await import('fs/promises').then((fs) => fs.readFile(targetFile, 'utf-8'))).toBe(originalContent);
    expect(fileReadTracker.hasBeenRead(targetFile)).toBe(true);
    const trackedRecord = fileReadTracker.getReadRecord(targetFile);
    const stats = await import('fs/promises').then((fs) => fs.stat(targetFile));
    expect(trackedRecord?.mtime).toBe(stats.mtimeMs);
    expect(trackedRecord?.size).toBe(stats.size);
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
        targetReadCount: 1,
        blockedToolCount: 1,
        noOpPatchCount: 0,
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
    expect(ctx.artifactRepairGuard?.noOpPatchCount).toBe(1);
    expect(ctx.artifactRepairGuard?.blockedToolCount).toBe(2);
    expect(ctx.needsReinference).toBe(true);
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
        targetReadCount: 1,
        blockedToolCount: 2,
        noOpPatchCount: 1,
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
        targetReadCount: 1,
        blockedToolCount: 1,
        noOpPatchCount: 1,
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
    expect(ctx.artifactRepairGuard?.noOpPatchCount).toBe(1);
    expect(ctx.artifactRepairGuard?.blockedToolCount).toBe(3);
    expect(toolExecutor.execute).not.toHaveBeenCalled();
    expect(contextAssembly.pushPersistentSystemContext).toHaveBeenCalledWith(
      expect.stringContaining('<artifact-repair-recovery>'),
    );
  });

  it('blocks full artifact Write during targeted contract repair', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-artifact-repair-targeted-write-'));
    const targetFile = path.join(dir, 'game.html');
    await writeFile(targetFile, `
      <!doctype html>
      <html><body><canvas id="game"></canvas><script>
      window.__GAME_TEST__ = {
        start() { return { mode: 'playing' }; },
        snapshot() { return { playerX: 0, mode: 'playing' }; },
        runSmokeTest() { return { passed: false, checks: [], failures: ['coverage'], coverage: {} }; }
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
        phase: 'baseline_repair',
        targetReadCount: 1,
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
      makeCompleteHtmlWriteToolCall('repair-targeted-write', targetFile),
    ]);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Write would replace the complete artifact during a targeted contract/metadata repair');
    expect(ctx.artifactRepairGuard?.preferTargetedEdit).toBe(true);
    expect(ctx.artifactRepairGuard?.blockedToolCount).toBe(3);
    expect(toolExecutor.execute).not.toHaveBeenCalled();
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
          targetReadCount: 1,
          blockedToolCount: 2,
          noOpPatchCount: 1,
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
      expect(ctx.artifactRepairGuard?.preferTargetedEdit).not.toBe(true);
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
        targetReadCount: 1,
        noOpPatchCount: 1,
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
        targetReadCount: 1,
        noOpPatchCount: 1,
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
        targetReadCount: 1,
        noOpPatchCount: 1,
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
        targetReadCount: 1,
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
        <canvas id="game" width="320" height="180" style="width: 100%; max-width: 320px; height: auto; aspect-ratio: 16 / 9;"></canvas>
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
        <canvas id="game" width="320" height="180" style="width: 100%; max-width: 320px; height: auto; aspect-ratio: 16 / 9;"></canvas>
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
