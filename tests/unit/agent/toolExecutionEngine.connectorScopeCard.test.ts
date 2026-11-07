// ============================================================================
// MCP 权限范围不足 → 引擎在 tool_call_end 之后发 connector_required(reason:'insufficient_scope')
// （N-CONNECTOR-POLISH-AUDIT-FU4-SCOPE）。ctx.onEvent 是 agentAppService(TaskManager) 与
// web routes/agent 两条发射路径共用的源头。
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import type { ToolCall, ToolResult } from '../../../src/shared/contract';
import { ToolExecutionEngine } from '../../../src/host/agent/runtime/toolExecutionEngine';
import { AntiPatternDetector } from '../../../src/host/agent/antiPattern/detector';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';
import { buildInsufficientScopeConnectorEvent } from '../../../src/host/agent/runtime/connectorScopeCard';

const serviceMocks = vi.hoisted(() => ({
  langfuse: {
    startNestedSpan: vi.fn(),
    endSpan: vi.fn(),
  },
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

function makeRuntimeContext(execute: RuntimeContext['toolExecutor']['execute']): RuntimeContext {
  return {
    systemPrompt: '',
    modelConfig: { provider: 'openai', model: 'gpt-test' } as never,
    toolExecutor: { execute } as never,
    messages: [],
    onEvent: vi.fn(),
    modelRouter: {} as never,
    maxIterations: 10,
    workingDirectory: '/tmp/code-agent-test',
    isDefaultWorkingDirectory: false,
    sessionId: 'session-failed-round-guard',
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
    control: ControlState.forTest(),
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

function makeEngine(execute: RuntimeContext['toolExecutor']['execute']) {
  const ctx = makeRuntimeContext(execute);
  const engine = new ToolExecutionEngine(ctx);
  engine.setModules(
    {
      injectSystemMessage: vi.fn(),
      pushPersistentSystemContext: vi.fn(),
      getCurrentAttachments: vi.fn().mockReturnValue([]),
    } as never,
    { emitTaskProgress: vi.fn() } as never,
    { setPlanMode: vi.fn(), isPlanMode: vi.fn().mockReturnValue(false), generateAutoContinuationPrompt: vi.fn() } as never,
  );
  return { ctx, engine };
}

const scopeFailure = (extra: Record<string, unknown> = {}): ToolResult => ({
  toolCallId: '',
  success: false,
  error: 'insufficient_scope: ...',
  metadata: { mcpInsufficientScope: { requiredScope: 'write' }, serverName: 'notion', ...extra },
});

function connectorEvents(ctx: RuntimeContext) {
  return (ctx.onEvent as ReturnType<typeof vi.fn>).mock.calls
    .map(([event]) => event as { type: string; data: unknown })
    .filter((event) => event.type === 'connector_required');
}

describe('insufficient_scope → connector_required card', () => {
  it('emits exactly one card per failing MCP tool call, after tool_call_end', async () => {
    const { ctx, engine } = makeEngine(vi.fn(async () => scopeFailure()));
    await engine.executeToolsWithHooks([{ id: 'c1', name: 'mcp__notion__write_page', arguments: {} } as ToolCall]);
    const types = (ctx.onEvent as ReturnType<typeof vi.fn>).mock.calls.map(([event]) => (event as { type: string }).type);
    expect(connectorEvents(ctx)).toEqual([{
      type: 'connector_required',
      data: { connectors: [{ id: 'notion', source: 'selected', reason: 'insufficient_scope', requiredScope: 'write' }] },
    }]);
    expect(types.indexOf('connector_required')).toBeGreaterThan(types.lastIndexOf('tool_call_end') - 1);
  });

  it('does not emit for ordinary failures or successes', async () => {
    const plain = makeEngine(vi.fn(async (): Promise<ToolResult> => ({ toolCallId: '', success: false, error: 'boom' })));
    await plain.engine.executeToolsWithHooks([{ id: 'c2', name: 'mcp__notion__write_page', arguments: {} } as ToolCall]);
    expect(connectorEvents(plain.ctx)).toEqual([]);
    const ok = makeEngine(vi.fn(async (): Promise<ToolResult> => ({ toolCallId: '', success: true, output: 'ok', metadata: { mcpInsufficientScope: {}, serverName: 'notion' } })));
    await ok.engine.executeToolsWithHooks([{ id: 'c3', name: 'mcp__notion__write_page', arguments: {} } as ToolCall]);
    expect(connectorEvents(ok.ctx)).toEqual([]);
  });
});

describe('buildInsufficientScopeConnectorEvent helpUrl', () => {
  it('no table entry → no helpUrl key; table entry → helpUrl; default table ships empty', () => {
    const none = buildInsufficientScopeConnectorEvent(scopeFailure(), {});
    expect(JSON.stringify(none)).not.toContain('helpUrl');
    const withEntry = buildInsufficientScopeConnectorEvent(scopeFailure(), { notion: 'https://example.test/permissions' });
    expect(withEntry).toMatchObject({ data: { connectors: [{ id: 'notion', helpUrl: 'https://example.test/permissions' }] } });
    expect(JSON.stringify(buildInsufficientScopeConnectorEvent(scopeFailure()))).not.toContain('helpUrl');
    expect(buildInsufficientScopeConnectorEvent(scopeFailure({ serverName: undefined, server: 'notion' }))).not.toBeNull();
  });
});
