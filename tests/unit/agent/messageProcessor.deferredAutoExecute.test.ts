// ============================================================================
// 模型直调未解锁的 deferred 工具（WebFetch / notebook_edit ...）时，host 解锁后
// 应当在同一轮内直接代执行，而不是合成一条 "Call it again" 失败结果白等一轮。
//
// 红线：代执行不得另开执行路径——必须汇入 handleToolResponse 里那唯一一处
// executeToolsWithHooks，审批 / hook / 安全链与普通工具调用完全同源。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../../../src/host/agent/loopTypes';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import type { ContextAssembly } from '../../../src/host/agent/runtime/contextAssembly';
import type { RunFinalizer } from '../../../src/host/agent/runtime/runFinalizer';
import type { Message, ToolResult } from '../../../src/shared/contract';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';

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
import { ToolExecutionEngine } from '../../../src/host/agent/runtime/toolExecutionEngine';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';
import { getToolSearchService } from '../../../src/host/services/toolSearch/toolSearchService';

type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { -readonly [P in keyof T]?: DeepPartial<T[P]> }
    : T;

/** 模型直调 WebFetch（渐进披露工具，首轮不在可见工具表里）。 */
const WEB_FETCH_CALL = { id: 'wf-1', name: 'WebFetch', arguments: { url: 'https://example.com' } };
/** 需要审批的 deferred 工具（permissionLevel: write）。 */
const NOTEBOOK_EDIT_CALL = {
  id: 'nb-1',
  name: 'notebook_edit',
  arguments: { notebook_path: '/tmp/x.ipynb', new_source: 'print(1)' },
};

/** 可见工具表里只有核心工具，被测调用一律不在其中。 */
const VISIBLE_CORE_ONLY = ['Bash', 'Read', 'Write'];

function buildCtx(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'runtime-session-1',
    runId: 'run-1',
    workingDirectory: '/tmp/code-agent-test',
    messages: [{ id: 'user-1', role: 'user', content: '打开 example.com 看看标题', timestamp: Date.now() }] as Message[],
    artifact: ArtifactState.forTest(),
    modelConfig: { provider: 'zhipu', model: 'glm-5', maxTokens: 16384 },
    contextHealth: ContextHealthState.forTest({ currentSystemPromptHash: 'hash-1' } as never),
    MAX_CONSECUTIVE_TRUNCATIONS: 3,
    turn: TurnState.forTest({ effortLevel: 'medium', currentTurnId: 'turn-1', currentIterationSpanId: 'iteration-1' } as never),
    turnQualityState: {},
    control: ControlState.forTest({} as never),
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
    maxToolCallRetries: 0,
    ...overrides,
  };
}

function buildDeps(ctx: { messages: Message[] }) {
  const persisted: Message[] = [];
  const injected: string[] = [];
  const contextAssembly = {
    generateId: vi.fn(() => `msg-${persisted.length + 1}`),
    addAndPersistMessage: vi.fn(async (message: Message) => {
      persisted.push(message);
      ctx.messages.push(message);
    }),
    injectSystemMessage: vi.fn((msg: string) => { injected.push(msg); }),
    pushPersistentSystemContext: vi.fn(),
    stripInternalFormatMimicry: vi.fn((value: string) => value),
    flushHookMessageBuffer: vi.fn(),
    updateContextHealth: vi.fn(),
    checkAndAutoCompress: vi.fn(),
    maybeInjectThinking: vi.fn(),
    getCurrentAttachments: vi.fn(() => []),
    formatArtifactRepairToolResultContent: vi.fn((_r: ToolResult, output: string) => output),
  };
  const runFinalizer = {
    emitTaskProgress: vi.fn(),
    emitTaskComplete: vi.fn(),
    tryParseTodosFromResponse: vi.fn(),
    autoAdvanceTodos: vi.fn(),
  };
  return { contextAssembly, runFinalizer, persisted, injected };
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

function toolUseResponse(calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>) {
  return {
    type: 'tool_use',
    content: '',
    toolCalls: calls,
    runtimeDiagnostics: { visibleToolNames: VISIBLE_CORE_ONLY },
  } as unknown as ModelResponse;
}

/** 组装一个真 ToolExecutionEngine（gate stack 全真，只有最末端的 toolExecutor 是 spy）。 */
function makeRealEngine(ctx: Record<string, unknown>, deps: ReturnType<typeof buildDeps>) {
  const engine = new ToolExecutionEngine(ctx as unknown as RuntimeContext);
  engine.setModules(
    deps.contextAssembly as never,
    deps.runFinalizer as never,
    { setPlanMode: vi.fn(), isPlanMode: vi.fn().mockReturnValue(false) } as never,
  );
  return engine;
}

describe('deferred 工具首调：解锁后同轮代执行', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionManagerState.addMessageToSession.mockResolvedValue(undefined);
    getToolSearchService().resetLoadedTools();
  });

  it('把解锁后的调用原样交给普通工具执行链，不再合成「Call it again」失败', async () => {
    const ctx = buildCtx();
    const deps = buildDeps(ctx);
    const toolEngine = {
      executeToolsWithHooks: vi.fn(async (): Promise<ToolResult[]> => [
        { toolCallId: 'wf-1', success: true, output: 'Example Domain', duration: 12 },
      ]),
    };
    const processor = makeProcessor(ctx, deps, toolEngine);

    const action = await processor.handleToolResponse(toolUseResponse([WEB_FETCH_CALL]), false, 1, { endSpan: vi.fn() } as never);

    expect(action).toBe('continue');
    // 同一入口、同一份 toolCalls：代执行没有另开路径
    expect(toolEngine.executeToolsWithHooks).toHaveBeenCalledTimes(1);
    expect(toolEngine.executeToolsWithHooks).toHaveBeenCalledWith([WEB_FETCH_CALL]);
    // 真实结果落库，机器话术不再出现在任何一条消息里
    const toolMessage = deps.persisted.find((m) => m.role === 'tool');
    expect(toolMessage?.toolResults?.[0]).toMatchObject({ success: true, output: 'Example Domain' });
    const allText = JSON.stringify(deps.persisted) + deps.injected.join('\n');
    expect(allText).not.toContain('Call it again');
    expect(allText).not.toContain('auto-loaded');
    // 工具确实被解锁了（下一轮 schema 可见）
    expect(getToolSearchService().isToolLoaded('WebFetch')).toBe(true);
  });

  it('代执行仍走审批/hook 闸：被 PreToolUse 拦下时工具执行器根本不会被调到', async () => {
    const toolExecutor = { execute: vi.fn() };
    const ctx = buildCtx({
      toolExecutor,
      hookManager: {
        triggerPreToolUse: vi.fn(async () => ({
          shouldProceed: false,
          message: 'notebook 写入需要人工确认',
          results: [],
          totalDuration: 1,
        })),
        triggerPostToolUse: vi.fn(async () => ({ shouldProceed: true, results: [], totalDuration: 0 })),
      },
    });
    const deps = buildDeps(ctx);
    const processor = makeProcessor(ctx, deps, makeRealEngine(ctx, deps));

    await processor.handleToolResponse(toolUseResponse([NOTEBOOK_EDIT_CALL]), false, 1, { endSpan: vi.fn() } as never);

    expect(ctx.hookManager.triggerPreToolUse).toHaveBeenCalledWith(
      'notebook_edit',
      JSON.stringify(NOTEBOOK_EDIT_CALL.arguments),
      'runtime-session-1',
    );
    expect(toolExecutor.execute).not.toHaveBeenCalled();
    const toolMessage = deps.persisted.find((m) => m.role === 'tool');
    expect(toolMessage?.toolResults?.[0]).toMatchObject({ success: false });
    expect(toolMessage?.toolResults?.[0]?.error).toContain('blocked by hook');
  });

  it('闸放行时，代执行抵达与普通调用同一个工具执行器入口（含完整 ToolContext）', async () => {
    const toolExecutor = {
      execute: vi.fn(async (): Promise<ToolResult> => ({ toolCallId: '', success: true, output: 'edited' })),
    };
    const ctx = buildCtx({
      toolExecutor,
      hookManager: {
        triggerPreToolUse: vi.fn(async () => ({ shouldProceed: true, results: [], totalDuration: 0 })),
        triggerPostToolUse: vi.fn(async () => ({ shouldProceed: true, results: [], totalDuration: 0 })),
      },
    });
    const deps = buildDeps(ctx);
    const processor = makeProcessor(ctx, deps, makeRealEngine(ctx, deps));

    await processor.handleToolResponse(toolUseResponse([NOTEBOOK_EDIT_CALL]), false, 1, { endSpan: vi.fn() } as never);

    expect(toolExecutor.execute).toHaveBeenCalledWith(
      'notebook_edit',
      NOTEBOOK_EDIT_CALL.arguments,
      expect.objectContaining({ sessionId: 'runtime-session-1', hookManager: ctx.hookManager }),
    );
  });

  it('strict skill 边界挡着的工具不代执行，回落到旧的下一轮重试话术', async () => {
    const ctx = buildCtx({
      turn: TurnState.forTest({
        effortLevel: 'medium',
        currentTurnId: 'turn-1',
        currentIterationSpanId: 'iteration-1',
        skillToolBoundary: { skillName: 'edit-role', strict: true, allowedTools: ['Read'] },
      } as never),
    });
    const deps = buildDeps(ctx);
    const toolEngine = { executeToolsWithHooks: vi.fn() };
    const processor = makeProcessor(ctx, deps, toolEngine);

    const action = await processor.handleToolResponse(toolUseResponse([WEB_FETCH_CALL]), false, 1, { endSpan: vi.fn() } as never);

    expect(action).toBe('continue');
    // 刻意收窄的门不许被代执行绕过
    expect(toolEngine.executeToolsWithHooks).not.toHaveBeenCalled();
    const toolMessage = deps.persisted.find((m) => m.role === 'tool');
    expect(toolMessage?.toolResults?.[0]?.error).toContain('Call it again');
  });

  it('同一轮里只解锁得了一部分时不代执行（另一半仍不可调用）', async () => {
    const ctx = buildCtx();
    const deps = buildDeps(ctx);
    const toolEngine = { executeToolsWithHooks: vi.fn() };
    const processor = makeProcessor(ctx, deps, toolEngine);

    const action = await processor.handleToolResponse(
      toolUseResponse([WEB_FETCH_CALL, { id: 'ghost-1', name: 'TotallyMadeUpTool', arguments: {} }]),
      false,
      1,
      { endSpan: vi.fn() } as never,
    );

    expect(action).toBe('continue');
    expect(toolEngine.executeToolsWithHooks).not.toHaveBeenCalled();
  });
});
