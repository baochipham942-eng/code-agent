// ============================================================================
// 强制收尾（forceFinalResponse）生效后的工具通道封口（issue #1991）
//
// 夜跑 2026-09-20：只读循环撞硬阈值强制收尾后，模型仍继续发工具调用 ——
// 全部被 "Tool skipped because final response is already forced" 拦下且记为
// 工具失败（单会话 136 次，遥测全脏），89 秒空烧 153 次工具派发。
// 封口语义：
//   1) forceFinal 置位时文本里的工具调用描述不再被 detectAndForceExecuteTextToolCall
//      解析代执行；
//   2) forceFinal 置位时 tool_use 响应整轮不派发 executor、不写工具失败遥测，
//      合成 skipped 结果落账后直接走强制收尾结论。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../../../src/host/agent/loopTypes';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import type { ContextAssembly } from '../../../src/host/agent/runtime/contextAssembly';
import type { RunFinalizer } from '../../../src/host/agent/runtime/runFinalizer';
import type { ToolExecutionEngine } from '../../../src/host/agent/runtime/toolExecutionEngine';
import type { Message, ToolCall } from '../../../src/shared/contract';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';

const cancelTimeWakesOnUserReturn = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../../src/host/services/wake/userReturn', () => ({ cancelTimeWakesOnUserReturn }));

const sessionManagerState = vi.hoisted(() => ({
  addMessage: vi.fn(),
  addMessageToSession: vi.fn(),
}));

vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => sessionManagerState,
  getLangfuseService: () => ({ startNestedSpan: vi.fn(), endSpan: vi.fn() }),
  getConfigService: vi.fn(),
  getAuthService: vi.fn(),
  getBudgetService: vi.fn(),
  BudgetAlertLevel: {},
}));

vi.mock('../../../src/host/services/git/fileWatcherService', () => ({
  getFileWatcherService: () => ({
    getRecentExternalChanges: vi.fn().mockReturnValue([]),
    markAsAgentModified: vi.fn(),
  }),
}));

vi.mock('../../../src/host/services/git/gitStatusService', () => ({
  getGitStatusService: () => ({ onPostToolUse: vi.fn() }),
}));

vi.mock('../../../src/host/services/citation/citationService', () => ({
  getCitationService: () => ({ extractAndStore: vi.fn().mockReturnValue([]) }),
}));

vi.mock('../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => ({
    getToolAnnotationsMap: () => new Map(),
    getToolDefinitions: () => [],
    parseMCPToolName: () => null,
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/host/mcp/logCollector.js', () => ({
  logCollector: {
    agent: vi.fn(),
    tool: vi.fn(),
    browser: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

import { MessageProcessor } from '../../../src/host/agent/runtime/messageProcessor';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';

const READ_LOOP_REASON = '连续只读操作达到硬阈值，已在执行前阻止 Read';

function buildCtx(controlSeed: { forceFinalResponseReason: string; forceFinalResponsePrompt?: string }) {
  return {
    sessionId: 'runtime-session-1',
    runId: 'run-1',
    workingDirectory: '/tmp/code-agent-test',
    messages: [{ id: 'user-1', role: 'user', content: '分析一下', timestamp: Date.now() }] as Message[],
    artifact: ArtifactState.forTest(),
    modelConfig: { provider: 'longcat', model: 'LongCat-2.0', maxTokens: 16384 },
    contextHealth: ContextHealthState.forTest({ currentSystemPromptHash: 'hash-1' } as never),
    MAX_CONSECUTIVE_TRUNCATIONS: 3,
    turn: TurnState.forTest({ effortLevel: 'medium', currentTurnId: 'turn-1', currentIterationSpanId: 'iteration-1' } as never),
    turnQualityState: {},
    control: ControlState.forTest(controlSeed as never),
    stats: RunStatsState.forTest({ traceId: 'trace-1', totalToolCallCount: 0 } as never),
    nudgeManager: {
      runNudgeChecks: vi.fn(() => false),
      runOutputValidation: vi.fn(() => false),
      getModifiedFiles: vi.fn(() => new Set<string>()),
      trackModifiedFile: vi.fn(),
      checkProgressState: vi.fn(),
      checkPostForceExecute: vi.fn(),
    },
    antiPatternDetector: {
      detectFailedToolCallPattern: vi.fn(),
      tryForceExecuteTextToolCall: vi.fn(),
      generateToolCallFormatError: vi.fn(),
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
    },
    circuitBreaker: {
      recordFailure: vi.fn().mockReturnValue(false),
      recordSuccess: vi.fn(),
      generateWarningMessage: vi.fn(),
      generateUserErrorMessage: vi.fn(),
    },
    goalTracker: { recordAction: vi.fn() },
    turnTrace: { setTurn: vi.fn(), record: vi.fn(), flush: vi.fn(), getEvents: vi.fn().mockReturnValue([]) },
    onEvent: vi.fn(),
    telemetryAdapter: {
      onTurnStart: vi.fn(),
      onModelCall: vi.fn(),
      onToolCallStart: vi.fn(),
      onToolCallEnd: vi.fn(),
      onTurnEnd: vi.fn(),
    },
    toolExecutor: { execute: vi.fn() },
    enableHooks: true,
    enableDeliveryCritic: false,
    maxToolCallRetries: 3,
  };
}

function buildDeps(ctx: { messages: Message[] }) {
  const persisted: Message[] = [];
  const contextAssembly = {
    generateId: vi.fn(() => `msg-${persisted.length + 1}`),
    addAndPersistMessage: vi.fn(async (message: Message) => {
      persisted.push(message);
      ctx.messages.push(message);
    }),
    injectSystemMessage: vi.fn(),
    pushPersistentSystemContext: vi.fn(),
    stripInternalFormatMimicry: vi.fn((value: string) => value),
    flushHookMessageBuffer: vi.fn(),
    updateContextHealth: vi.fn(),
    checkAndAutoCompress: vi.fn(),
    maybeInjectThinking: vi.fn(),
  };
  const runFinalizer = {
    emitTaskProgress: vi.fn(),
    emitTaskComplete: vi.fn(),
    tryParseTodosFromResponse: vi.fn(),
    autoAdvanceTodos: vi.fn(),
  };
  return { contextAssembly, runFinalizer, persisted };
}

function makeProcessor(
  ctx: Record<string, unknown>,
  deps: ReturnType<typeof buildDeps>,
  toolEngine: unknown,
): MessageProcessor {
  return new MessageProcessor(
    ctx as unknown as RuntimeContext,
    deps.contextAssembly as unknown as ContextAssembly,
    deps.runFinalizer as unknown as RunFinalizer,
    toolEngine as ToolExecutionEngine,
  );
}

const TOOL_CALLS: ToolCall[] = [
  { id: 'call-1', name: 'Read', arguments: { file_path: '/tmp/a.ts' } },
  { id: 'call-2', name: 'Glob', arguments: { pattern: '**/*.ts' } },
];

function toolUseResponse(): ModelResponse {
  return { type: 'tool_use', content: '', toolCalls: TOOL_CALLS } as unknown as ModelResponse;
}

const langfuse = { endSpan: vi.fn() };

describe('forceFinal 封口（issue #1991）', () => {
  beforeEach(() => {
    sessionManagerState.addMessage.mockReset();
    sessionManagerState.addMessageToSession.mockReset();
    langfuse.endSpan.mockClear();
  });

  it('forceFinal 置位时不再把文本工具调用描述解析代执行', () => {
    const ctx = buildCtx({ forceFinalResponseReason: READ_LOOP_REASON });
    const deps = buildDeps(ctx);
    const processor = makeProcessor(ctx, deps, { executeToolsWithHooks: vi.fn() });
    const response = {
      type: 'text',
      content: 'Ran: cat evidence.txt',
    } as unknown as ModelResponse;

    const result = processor.detectAndForceExecuteTextToolCall(response);

    expect(result.wasForceExecuted).toBe(false);
    expect(result.shouldContinue).toBe(false);
    expect(result.response.type).toBe('text');
    expect(ctx.antiPatternDetector.detectFailedToolCallPattern).not.toHaveBeenCalled();
    expect(ctx.antiPatternDetector.tryForceExecuteTextToolCall).not.toHaveBeenCalled();
  });

  it('forceFinal 置位时 tool_use 整轮不派发 executor、不计工具失败遥测（defer 原因）', async () => {
    const ctx = buildCtx({
      forceFinalResponseReason: READ_LOOP_REASON,
      forceFinalResponsePrompt: '<force-final-response reason="read-loop-hard-limit">…</force-final-response>',
    });
    const deps = buildDeps(ctx);
    const executeToolsWithHooks = vi.fn();
    const processor = makeProcessor(ctx, deps, { executeToolsWithHooks });

    const action = await processor.handleToolResponse(toolUseResponse(), false, 3, langfuse as never);

    // defer 原因：'continue' 交给 inference 层做一次禁工具最终推理
    expect(action).toBe('continue');
    expect(executeToolsWithHooks).not.toHaveBeenCalled();
    expect(ctx.toolExecutor.execute).not.toHaveBeenCalled();
    expect(ctx.telemetryAdapter.onToolCallStart).not.toHaveBeenCalled();
    expect(ctx.telemetryAdapter.onToolCallEnd).not.toHaveBeenCalled();

    // assistant + tool 两条消息落账；tool 结果是 suppressed skip，不是真失败
    const toolMessage = deps.persisted.find((message) => message.role === 'tool');
    expect(toolMessage?.toolResults).toHaveLength(2);
    for (const result of toolMessage?.toolResults ?? []) {
      expect(result.success).toBe(false);
      expect(result.error).toContain('final response is already forced');
      expect(result.metadata).toMatchObject({ skipped: true, forceFinalSuppressed: true });
    }
    // defer 路径不清 forceFinal（由后续禁工具最终推理的文本轮清理）
    expect(ctx.control.forceFinalResponseReason).toBe(READ_LOOP_REASON);
    expect(ctx.telemetryAdapter.onTurnEnd).toHaveBeenCalledTimes(1);
  });

  it('forceFinal 置位时 tool_use 整轮不派发 executor、不计工具失败遥测（非 defer 原因 → 就地收尾 break）', async () => {
    const ctx = buildCtx({ forceFinalResponseReason: 'artifact repair unavailable tool repeated: Bash' });
    const deps = buildDeps(ctx);
    const executeToolsWithHooks = vi.fn();
    const processor = makeProcessor(ctx, deps, { executeToolsWithHooks });

    const action = await processor.handleToolResponse(toolUseResponse(), false, 3, langfuse as never);

    expect(action).toBe('break');
    expect(executeToolsWithHooks).not.toHaveBeenCalled();
    expect(ctx.toolExecutor.execute).not.toHaveBeenCalled();
    expect(ctx.telemetryAdapter.onToolCallEnd).not.toHaveBeenCalled();

    const finalMessage = deps.persisted.find(
      (message) => message.role === 'assistant' && typeof message.content === 'string' && message.content.includes('任务已结束'),
    );
    expect(finalMessage).toBeDefined();
    // 非 defer 收尾：forceFinal 被清理
    expect(ctx.control.forceFinalResponseReason).toBeUndefined();
  });

  it('抑制结果的 consecutiveErrors 不累计（turnTrace 记 skipped 而非 failed）', async () => {
    const ctx = buildCtx({ forceFinalResponseReason: READ_LOOP_REASON });
    const deps = buildDeps(ctx);
    const processor = makeProcessor(ctx, deps, { executeToolsWithHooks: vi.fn() });

    await processor.handleToolResponse(toolUseResponse(), false, 3, langfuse as never);

    const dispatchEvents = vi.mocked(ctx.turnTrace.record).mock.calls
      .filter(([event]) => event === 'tool_dispatch')
      .map(([, data]) => data as { outcome: string });
    expect(dispatchEvents).toHaveLength(2);
    expect(dispatchEvents.every((event) => event.outcome === 'skipped')).toBe(true);
  });
});
