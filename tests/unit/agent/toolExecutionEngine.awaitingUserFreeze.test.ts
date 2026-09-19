// ============================================================================
// 问句未答冻结（awaiting-user freeze · N-SAFETY-DENY-THEN-DELETE）
//
// 2026-09-18 夜跑事故：无头环境 AskUserQuestion 回退文案明写「不要创建、修改或
// 删除任何文件」，模型下一条消息直接 rm -rf 48 个文件。本文件钉引擎硬约束：
// 工具返回带 awaitingUserInput 后，本 run 内非 read 级工具不再 dispatch，
// 只读与 AskUserQuestion 本身放行，resetRepairGate（run 边界）解冻。
// ============================================================================
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setProtocolToolRegistryPort } from '../../../src/host/tools/protocolToolRegistration';
import type { ToolCall, ToolResult } from '../../../src/shared/contract';
import { ToolExecutionEngine } from '../../../src/host/agent/runtime/toolExecutionEngine';
import { getToolAttemptTrace } from '../../../src/host/agent/runtime/toolAttemptTrace';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { fileReadTracker } from '../../../src/host/tools/fileReadTracker';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';

const serviceMocks = vi.hoisted(() => ({
  langfuse: {
    startNestedSpan: vi.fn(),
    endSpan: vi.fn(),
  },
  injected: [] as string[],
}));

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
    sessionId: 'session-awaiting-freeze',
    persistLongTermMemory: true,
    includeRecentConversations: true,
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
    enableToolDeferredLoading: false,
    maxMode: false,
    maxModeCandidates: 1,
    maxStructuredOutputRetries: 0,
    stepByStepMode: false,
    turnQualityState: {},
    goalEvidenceState: { bounces: 0 },
    control: ControlState.forTest({} as never),
    budgetScope: 'foreground',
    consecutiveErrors: 0,
    stats: RunStatsState.forTest({ traceId: 'trace-1', totalInputTokens: 0, totalOutputTokens: 0, runStartTime: Date.now(), totalTokensUsed: 0, totalToolCallCount: 0 } as never),
    MAX_CONSECUTIVE_TRUNCATIONS: 3,
    MAX_CONSECUTIVE_COMPACTS: 3,
    contextHealth: ContextHealthState.forTest({ persistentSystemContext: [] } as never),
    artifact: ArtifactState.forTest(),
    enableDeliveryCritic: false,
    ...overrides,
  };
}

const QUESTION_ARGS = {
  questions: [
    {
      question: '删了不可恢复，确认全部删除？',
      header: '确认',
      options: [
        { label: '全部删除', description: '不可恢复' },
        { label: '取消', description: '保留文件' },
      ],
    },
  ],
};

/** 模拟 toolResolver 对 AskUserQuestion 无头回退产出的引擎级结果（meta→metadata 透传）。 */
const headlessAskResult: ToolResult = {
  toolCallId: '',
  success: true,
  output: '[用户未响应 - CLI 模式无法交互]\n\n[确认] 删了不可恢复，确认全部删除？\n\n⚠️ 用户无法回答问题。请不要自行选择选项，而是基于当前已知信息给出分析和建议，等待用户下一步指示。不要创建、修改或删除任何文件。',
  metadata: {
    permissionDecision: 'deny',
    permissionDecisionReason: '当前运行环境没有可投递的交互界面，用户问题已按无头规则安全拒绝。',
    awaitingUserInput: true,
    executionStarted: true,
  },
};

describe('问句未答冻结（awaiting-user freeze）', () => {
  beforeAll(() => {
    // scoped 注册四条真实形状的 schema：走真 getToolDefinitionWithCloudMeta 的
    // permissionLevel/requiresPermission 映射，其余工具名解析 undefined。
    const schemas: Array<Record<string, unknown>> = [
      {
        name: 'AskUserQuestion',
        description: 'test ask',
        inputSchema: { type: 'object', properties: { questions: { type: 'array' } }, required: ['questions'] },
        permissionLevel: 'execute',
        requiresPermission: false,
      },
      {
        name: 'Bash',
        description: 'test bash',
        inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
        permissionLevel: 'execute',
      },
      {
        name: 'Write',
        description: 'test write',
        inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] },
        permissionLevel: 'write',
      },
      {
        name: 'Read',
        description: 'test read',
        inputSchema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
        permissionLevel: 'read',
      },
      {
        name: 'delegate_task',
        description: 'test delegate',
        inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
        permissionLevel: 'execute',
        requiresPermission: false,
      },
    ];
    setProtocolToolRegistryPort({
      register: () => {},
      unregister: () => false,
      has: (n: string) => schemas.some((s) => s.name === n),
      getSchemas: () => schemas as never,
      resolve: async () => { throw new Error('unused in this test'); },
    } as never);
  });

  afterAll(() => {
    setProtocolToolRegistryPort({
      register: () => {}, unregister: () => false, has: () => false,
      getSchemas: () => [], resolve: async () => { throw new Error('reset'); },
    } as never);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    fileReadTracker.clear();
    serviceMocks.injected.length = 0;
  });

  function makeEngine() {
    const execute = vi.fn(async (name: string): Promise<ToolResult> => {
      if (name === 'AskUserQuestion') return { ...headlessAskResult, metadata: { ...headlessAskResult.metadata } };
      return {
        toolCallId: '',
        success: true,
        output: `${name} ok`,
        metadata: { executionStarted: true },
      };
    });
    const ctx = makeRuntimeContext({ toolExecutor: { execute } as never });
    const injectSystemMessage = vi.fn((message: string) => {
      serviceMocks.injected.push(message);
    });
    const engine = new ToolExecutionEngine(ctx);
    engine.setModules(
      { injectSystemMessage, pushPersistentSystemContext: vi.fn(), getCurrentAttachments: vi.fn().mockReturnValue([]) } as never,
      { emitTaskProgress: vi.fn() } as never,
      { setPlanMode: vi.fn(), isPlanMode: vi.fn().mockReturnValue(false) } as never,
    );
    return { ctx, engine, execute, injectSystemMessage };
  }

  it('无头 AskUserQuestion 之后：Bash/Write 在 dispatch 前被拒，Read 与再问放行，reset 后解冻', async () => {
    const { ctx, engine, execute } = makeEngine();

    // 1. AskUserQuestion 走无头回退（工具返回带 awaitingUserInput）
    const ask = await engine.executeSingleTool(
      { id: 'ask-1', name: 'AskUserQuestion', arguments: QUESTION_ARGS } as ToolCall, 0, 1,
    );
    expect(ask.success).toBe(true);
    expect(getToolAttemptTrace(ctx).awaitingUserInput).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);

    // 2. Bash（原始事故形状）被拒：未 dispatch、带 <awaiting-user-input> 与 blocked 元数据
    const bash = await engine.executeSingleTool(
      { id: 'rm-1', name: 'Bash', arguments: { command: 'rm -rf 资料' } } as ToolCall, 0, 1,
    );
    expect(bash.success).toBe(false);
    expect(bash.error).toContain('<awaiting-user-input>');
    expect(bash.metadata).toMatchObject({
      blocked: true,
      awaitingUserInput: true,
      executionStarted: false,
      failureCode: 'permission-denied',
    });
    expect(execute).toHaveBeenCalledTimes(1); // 未 dispatch

    // 3. Write 同样被拒
    const write = await engine.executeSingleTool(
      { id: 'write-1', name: 'Write', arguments: { file_path: '/tmp/x.txt', content: 'x' } } as ToolCall, 0, 1,
    );
    expect(write.success).toBe(false);
    expect(write.error).toContain('<awaiting-user-input>');
    expect(write.metadata?.blocked).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);

    // 4. 只读工具照常放行
    const read = await engine.executeSingleTool(
      { id: 'read-1', name: 'Read', arguments: { file_path: '/tmp/x.txt' } } as ToolCall, 0, 1,
    );
    expect(read.success).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);

    // 5. AskUserQuestion 自身允许再问（按工具名豁免，不看 requiresPermission）
    const reask = await engine.executeSingleTool(
      { id: 'ask-2', name: 'AskUserQuestion', arguments: QUESTION_ARGS } as ToolCall, 0, 1,
    );
    expect(reask.success).toBe(true);
    expect(execute).toHaveBeenCalledTimes(3);

    // 6. 冻结提示一 run 只注入一次（两次被拒不重复注入）
    const freezeNotices = serviceMocks.injected.filter((m) => m.includes('<awaiting-user-input-freeze>'));
    expect(freezeNotices).toHaveLength(1);

    // 7. run 边界（resetRepairGate）解冻：Bash 恢复 dispatch
    engine.resetRepairGate();
    expect(getToolAttemptTrace(ctx).awaitingUserInput).toBe(false);
    const bashAfterReset = await engine.executeSingleTool(
      { id: 'rm-2', name: 'Bash', arguments: { command: 'rm -rf 资料' } } as ToolCall, 0, 1,
    );
    expect(bashAfterReset.success).toBe(true);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('被拒调用照常发遥测与 tool_call_end 事件（簿记不缺）', async () => {
    const { ctx, engine } = makeEngine();

    await engine.executeSingleTool(
      { id: 'ask-src', name: 'AskUserQuestion', arguments: QUESTION_ARGS } as ToolCall, 0, 1,
    );
    const blocked = await engine.executeSingleTool(
      { id: 'rm-tel', name: 'Bash', arguments: { command: 'rm -rf 资料' } } as ToolCall, 0, 1,
    );
    expect(blocked.success).toBe(false);

    expect(ctx.telemetryAdapter?.onToolCallEnd).toHaveBeenCalledWith(
      'turn-1',
      'rm-tel',
      false,
      expect.stringContaining('<awaiting-user-input>'),
      expect.any(Number),
      undefined,
      expect.objectContaining({ blocked: true, awaitingUserInput: true, executionStarted: false }),
    );
    const endEvent = vi.mocked(ctx.onEvent).mock.calls
      .map(([event]) => event)
      .find((event) => event.type === 'tool_call_end' && (event.data as ToolResult).toolCallId === 'rm-tel');
    expect(endEvent).toBeDefined();
    expect((endEvent?.data as ToolResult).error).toContain('<awaiting-user-input>');
    // trace 记账：preflight 拒绝、未执行
    const dispatchRecords = vi.mocked(ctx.turnTrace.record).mock.calls
      .filter(([type]) => type === 'tool_dispatch')
      .map(([, data]) => data as Record<string, unknown>);
    expect(dispatchRecords).toEqual([
      expect.objectContaining({ toolCallId: 'ask-src', outcome: 'succeeded' }),
      expect.objectContaining({ toolCallId: 'rm-tel', outcome: 'rejected', execution: 'not_executed' }),
    ]);
  });

  it('冻结期间 delegate_task（execute + requiresPermission:false）被拒，AskUserQuestion 与 read 级放行', async () => {
    const { engine, execute } = makeEngine();

    await engine.executeSingleTool(
      { id: 'ask-1', name: 'AskUserQuestion', arguments: QUESTION_ARGS } as ToolCall, 0, 1,
    );
    expect(execute).toHaveBeenCalledTimes(1);

    const delegated = await engine.executeSingleTool(
      { id: 'del-1', name: 'delegate_task', arguments: { prompt: '把资料全删了' } } as ToolCall, 0, 1,
    );
    expect(delegated.success).toBe(false);
    expect(delegated.error).toContain('<awaiting-user-input>');
    expect(delegated.metadata).toMatchObject({
      blocked: true,
      awaitingUserInput: true,
      executionStarted: false,
    });
    expect(execute).toHaveBeenCalledTimes(1);

    const reask = await engine.executeSingleTool(
      { id: 'ask-2', name: 'AskUserQuestion', arguments: QUESTION_ARGS } as ToolCall, 0, 1,
    );
    expect(reask.success).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);

    const read = await engine.executeSingleTool(
      { id: 'read-1', name: 'Read', arguments: { file_path: '/tmp/x.txt' } } as ToolCall, 0, 1,
    );
    expect(read.success).toBe(true);
    expect(execute).toHaveBeenCalledTimes(3);
  });
});
