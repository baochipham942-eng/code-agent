import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall, ToolResult } from '../../../src/shared/contract';
import { ToolExecutionEngine } from '../../../src/host/agent/runtime/toolExecutionEngine';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';
import { AntiPatternDetector } from '../../../src/host/agent/antiPattern/detector';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import type { MCPToolAnnotations } from '../../../src/host/mcp/types';

const ROOT = '/tmp/toolres-k2';

const mcpAnnotations = vi.hoisted(() => ({
  map: new Map<string, MCPToolAnnotations>(),
}));

vi.mock('../../../src/host/services', () => ({
  getConfigService: vi.fn(),
  getAuthService: vi.fn(),
  getBudgetService: vi.fn(),
  getSessionManager: vi.fn(),
  getLangfuseService: () => ({ startNestedSpan: vi.fn(), endSpan: vi.fn() }),
  BudgetAlertLevel: {},
}));

vi.mock('../../../src/host/services/citation/citationService', () => ({
  getCitationService: () => ({ extractAndStore: vi.fn().mockReturnValue([]) }),
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

vi.mock('../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => ({
    getToolAnnotationsMap: () => mcpAnnotations.map,
    getToolDefinitions: () => [],
  }),
}));

function makeRuntimeContext(execute: RuntimeContext['toolExecutor']['execute']): RuntimeContext {
  return {
    systemPrompt: '',
    modelConfig: { provider: 'openai', model: 'gpt-test' } as never,
    toolExecutor: { execute } as never,
    messages: [],
    onEvent: vi.fn(),
    modelRouter: {} as never,
    maxIterations: 10,
    workingDirectory: ROOT,
    isDefaultWorkingDirectory: false,
    sessionId: 'session-order-segments',
    persistLongTermMemory: true,
    includeRecentConversations: true,
    circuitBreaker: {
      recordFailure: vi.fn().mockReturnValue(false),
      recordSuccess: vi.fn(),
      generateWarningMessage: vi.fn(),
      generateUserErrorMessage: vi.fn(),
    } as never,
    antiPatternDetector: new AntiPatternDetector(),
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
    telemetryAdapter: {
      onTurnStart: vi.fn(),
      onModelCall: vi.fn(),
      onToolCallStart: vi.fn(),
      onToolCallEnd: vi.fn(),
      onTurnEnd: vi.fn(),
    },
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
    stats: RunStatsState.forTest({
      traceId: 'trace-1',
      totalInputTokens: 0,
      totalOutputTokens: 0,
      runStartTime: Date.now(),
      totalTokensUsed: 0,
      totalToolCallCount: 0,
    } as never),
    MAX_CONSECUTIVE_TRUNCATIONS: 3,
    MAX_CONSECUTIVE_COMPACTS: 3,
    contextHealth: ContextHealthState.forTest({ persistentSystemContext: [] } as never),
    artifact: ArtifactState.forTest(),
    enableDeliveryCritic: false,
  };
}

function makeEngine(execute: (name: string, args: Record<string, unknown>) => Promise<ToolResult>) {
  const ctx = makeRuntimeContext(execute as never);
  const engine = new ToolExecutionEngine(ctx);
  engine.setModules(
    {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
      getCurrentAttachments: vi.fn().mockReturnValue([]),
    } as never,
    { emitTaskProgress: vi.fn() } as never,
    { setPlanMode: vi.fn(), isPlanMode: vi.fn().mockReturnValue(false) } as never,
  );
  return { ctx, engine };
}

describe('engine order-preserving segments', () => {
  beforeEach(() => {
    getProtocolRegistry();
    mcpAnnotations.map.clear();
  });

  it('finishes the write before the same-path read starts', async () => {
    const trace: string[] = [];
    const { engine } = makeEngine(async (name) => {
      trace.push(`start:${name}`);
      await Promise.resolve();
      trace.push(`end:${name}`);
      return { toolCallId: '', success: true, output: name };
    });
    const results = await engine.executeToolsWithHooks([
      { id: 'write-a', name: 'Write', arguments: { file_path: 'a.txt', content: 'x' } },
      { id: 'read-a', name: 'Read', arguments: { file_path: 'a.txt' } },
    ]);
    expect(trace).toEqual(['start:Write', 'end:Write', 'start:Read', 'end:Read']);
    expect(results.map((result) => result.toolCallId)).toEqual(['write-a', 'read-a']);
    expect(results.every((result) => result.success)).toBe(true);
  });

  it('returns two different-path writes by original index when the second finishes first', async () => {
    let releaseSlow: () => void = () => {};
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let markSlowStarted: () => void = () => {};
    const slowStarted = new Promise<void>((resolve) => {
      markSlowStarted = resolve;
    });
    const finishes: string[] = [];
    const { engine } = makeEngine(async (_name, args) => {
      const file = String(args.file_path);
      if (file.endsWith('a.txt')) {
        markSlowStarted();
        await slowGate;
      } else {
        await slowStarted;
        releaseSlow();
      }
      finishes.push(file);
      return { toolCallId: '', success: true, output: file };
    });
    const results = await engine.executeToolsWithHooks([
      { id: 'write-a', name: 'Write', arguments: { file_path: 'a.txt', content: 'x' } },
      { id: 'write-b', name: 'Write', arguments: { file_path: 'b.txt', content: 'y' } },
    ]);
    expect(finishes).toEqual(['b.txt', 'a.txt']);
    expect(results.map((result) => result.toolCallId)).toEqual(['write-a', 'write-b']);
    expect(results.map((result) => result.output)).toEqual(['a.txt', 'b.txt']);
  });

  it('never runs more than four independent reads at once', async () => {
    let active = 0;
    let maxActive = 0;
    const { engine } = makeEngine(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { toolCallId: '', success: true, output: 'ok' };
    });
    const results = await engine.executeToolsWithHooks(
      Array.from({ length: 6 }, (_, index) => ({
        id: `read-${index}`,
        name: 'Read',
        arguments: { file_path: `file-${index}.txt` },
      })) as ToolCall[],
    );
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(results.map((result) => result.toolCallId)).toEqual(Array.from({ length: 6 }, (_, index) => `read-${index}`));
    expect(results.every((result) => result.success)).toBe(true);
  });

  it.each([
    ['AskUserQuestion', { questions: [] }],
    ['ask_user_question', { questions: [] }],
    ['confirm_action', { title: '删除', message: '确定删除？' }],
    ['exit_plan_mode', { plan: 'ship it' }],
    ['attempt_completion', { summary: 'done' }],
    ['PlanMode', { action: 'exit', plan: 'ship it' }],
  ] as const)('does not execute the write after %s', async (name, args) => {
    const executed: string[] = [];
    const { ctx, engine } = makeEngine(async (toolName) => {
      executed.push(toolName);
      return { toolCallId: '', success: true, output: toolName };
    });
    const results = await engine.executeToolsWithHooks([
      { id: 'barrier', name, arguments: { ...args } },
      { id: 'write-after', name: 'Write', arguments: { file_path: 'a.txt', content: 'x' } },
    ]);
    expect(executed).not.toContain('Write');
    expect(results[0]?.toolCallId).toBe('barrier');
    expect(results[1]?.toolCallId).toBe('write-after');
    expect(results[1]?.success).toBe(false);
    expect(results[1]?.error).toMatch(/^BATCH_TERMINATED/);
    expect(results[1]?.metadata).toMatchObject({
      skipped: true,
      blocked: true,
      deferred: true,
      code: 'BATCH_TERMINATED',
    });
    const telemetryIds = vi.mocked(ctx.telemetryAdapter!.onToolCallEnd).mock.calls.map((item) => item[1]);
    expect(telemetryIds).not.toContain('write-after');
    const events = vi.mocked(ctx.onEvent).mock.calls.map(([event]) => event);
    expect(events.some((event) => event.type === 'tool_call_start' && event.data?.id === 'write-after')).toBe(true);
    expect(events.some((event) => event.type === 'tool_call_end' && event.data?.toolCallId === 'write-after')).toBe(true);
  });

  it('still executes a write after PlanMode enter', async () => {
    const executed: string[] = [];
    const { engine } = makeEngine(async (name) => {
      executed.push(name);
      return { toolCallId: '', success: true, output: name };
    });
    const results = await engine.executeToolsWithHooks([
      { id: 'enter', name: 'PlanMode', arguments: { action: 'enter' } },
      { id: 'write-after', name: 'Write', arguments: { file_path: 'a.txt', content: 'x' } },
    ]);
    expect(executed).toEqual(['PlanMode', 'Write']);
    expect(results.map((result) => result.success)).toEqual([true, true]);
  });

  it('runs an unannotated MCP call before Read and overlaps an annotated read-only MCP with Read', async () => {
    const trace: string[] = [];
    let active = 0;
    let maxActive = 0;
    const { engine } = makeEngine(async (name) => {
      trace.push(`start:${name}`);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      trace.push(`end:${name}`);
      return { toolCallId: '', success: true, output: name };
    });
    await engine.executeToolsWithHooks([
      { id: 'mcp', name: 'mcp_docs_read', arguments: {} },
      { id: 'read-a', name: 'Read', arguments: { file_path: 'a.txt' } },
    ]);
    expect(trace).toEqual(['start:mcp_docs_read', 'end:mcp_docs_read', 'start:Read', 'end:Read']);

    trace.length = 0;
    maxActive = 0;
    mcpAnnotations.map.set('mcp_docs_read', { readOnlyHint: true });
    await engine.executeToolsWithHooks([
      { id: 'mcp', name: 'mcp_docs_read', arguments: {} },
      { id: 'read-a', name: 'Read', arguments: { file_path: 'a.txt' } },
    ]);
    expect(maxActive).toBe(2);
    expect(trace.filter((item) => item.startsWith('start:')).sort()).toEqual(['start:Read', 'start:mcp_docs_read']);
  });
});
