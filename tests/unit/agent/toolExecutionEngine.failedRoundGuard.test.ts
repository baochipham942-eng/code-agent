// ============================================================================
// executeToolsWithHooks 接入连续失败轮守卫（N-INFER-HANG-SPIN）
//
// 失败桩工具走真实执行入口。五轮后 reason 为 failed-round-guard，并满足
// shouldDeferForcedFinalToInference，从而进入现有的禁工具最终推理。
// 删掉引擎末尾那次 observeFailedToolRound 调用，本文件变红。
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall, ToolResult } from '../../../src/shared/contract';
import { ToolExecutionEngine } from '../../../src/host/agent/runtime/toolExecutionEngine';
import { AntiPatternDetector } from '../../../src/host/agent/antiPattern/detector';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';
import { shouldDeferForcedFinalToInference } from '../../../src/host/agent/runtime/messageProcessorHelpers';

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

describe('ToolExecutionEngine failed-round guard', () => {
  afterEach(() => {
    delete process.env.CODE_AGENT_FAILED_ROUND_GUARD;
  });

  it('trips failed-round-guard through executeToolsWithHooks after five failing stub rounds', async () => {
    const execute = vi.fn(async (): Promise<ToolResult> => ({
      toolCallId: '',
      success: false,
      error: 'soffice failed: exit status 1',
    }));
    const { ctx, engine } = makeEngine(execute);

    for (let index = 1; index <= 5; index += 1) {
      const [result] = await engine.executeToolsWithHooks([
        { id: `convert-${index}`, name: 'libreoffice_convert', arguments: { path: 'deck.pptx' } } as ToolCall,
      ]);
      expect(result).toMatchObject({ success: false, error: 'soffice failed: exit status 1' });
      if (index < 5) expect(ctx.control.forceFinalResponseReason).toBeUndefined();
    }

    expect(execute).toHaveBeenCalledTimes(5);
    expect(ctx.control.forceFinalResponseReason).toBe('failed-round-guard');
    const prompt = ctx.control.forceFinalResponsePrompt ?? '';
    expect(prompt).toContain('reason="failed-round-guard"');
    expect(prompt).toContain('libreoffice_convert');
    expect(prompt).toContain('soffice failed: exit status 1');
    expect(prompt).toContain('Do not claim success.');
    expect(prompt).toContain('State clearly whether any deliverable file exists.');
    expect(shouldDeferForcedFinalToInference(ctx)).toBe(true);
    expect(ctx.turnTrace.record).toHaveBeenCalledWith('failed_round_guard', {
      rounds: 5,
      toolNames: [
        'libreoffice_convert',
        'libreoffice_convert',
        'libreoffice_convert',
        'libreoffice_convert',
        'libreoffice_convert',
      ],
    });
  });
});
