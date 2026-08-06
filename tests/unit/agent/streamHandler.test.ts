import { describe, expect, it, vi } from 'vitest';
import { StreamHandler } from '../../../src/host/agent/runtime/streamHandler';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';
import {
  createRunTraceContext,
  getActiveRunTraceContext,
  withRunTraceContext,
} from '../../../src/host/telemetry/runTraceContext';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('StreamHandler', () => {
  it('accumulates input and output token counters for runtime accounting', () => {
    const ctx = {
      modelConfig: { provider: 'test-provider', model: 'test-model' },
      onEvent: vi.fn(),
      stats: RunStatsState.forTest({ totalTokensUsed: 0, totalInputTokens: 0, totalOutputTokens: 0 } as never),
    };
    const handler = new StreamHandler(ctx as any, {} as any, {} as any);

    handler.emitModelResponse({
      type: 'text',
      content: 'done',
      usage: { inputTokens: 120, outputTokens: 7 },
    } as any, 42);

    expect(ctx.stats.totalInputTokens).toBe(120);
    expect(ctx.stats.totalOutputTokens).toBe(7);
    expect(ctx.stats.totalTokensUsed).toBe(127);
    expect(ctx.onEvent).toHaveBeenCalledWith({
      type: 'model_response',
      data: expect.objectContaining({
        inputTokens: 120,
        outputTokens: 7,
      }),
    });
  });

  it('marks turn_start and runtime diagnostics as meta for hidden loop history', () => {
    const ctx = {
      modelConfig: { provider: 'test-provider', model: 'test-model' },
      onEvent: vi.fn(),
      historyVisibility: 'meta',
      stats: RunStatsState.forTest({ pendingRuntimeDiagnostics: ['diagnostic detail'], traceId: 'trace-1' } as never),
      turn: TurnState.forTest({ messageDeltaSeq: 99, toolsUsedInTurn: ['old-tool'] }),
      goalTracker: { getGoalCheckpoint: vi.fn().mockReturnValue(null) },
    };
    const runFinalizer = {
      emitTaskProgress: vi.fn(),
      emitTaskStats: vi.fn(),
    };
    const langfuse = {
      startSpan: vi.fn(),
    };
    const handler = new StreamHandler(ctx as any, { injectSystemMessage: vi.fn() } as any, runFinalizer as any);

    handler.setupIteration(1, 'check', langfuse as any);

    expect(ctx.onEvent).toHaveBeenCalledWith({
      type: 'turn_start',
      data: expect.objectContaining({
        turnId: expect.any(String),
        iteration: 1,
        isMeta: true,
      }),
    });
    expect(ctx.onEvent).toHaveBeenCalledWith({
      type: 'stream_reasoning',
      data: expect.objectContaining({
        content: expect.stringContaining('diagnostic detail'),
        turnId: expect.any(String),
        isMeta: true,
      }),
    });
  });

  it('enters a turn-scoped child context when the iteration begins', async () => {
    const run = createRunTraceContext({
      runId: 'run-stream',
      sessionId: 'session-stream',
      attempt: 1,
      ownerEpoch: 1,
      engine: 'native',
      workspace: '/tmp/stream',
      processInstanceId: 'process-stream',
    });
    const ctx = {
      runTraceContext: run,
      modelConfig: { provider: 'test-provider', model: 'test-model' },
      onEvent: vi.fn(),
      stats: RunStatsState.forTest({ traceId: run.traceId } as never),
      turn: TurnState.forTest(),
      goalTracker: { getGoalCheckpoint: vi.fn().mockReturnValue(null) },
    };
    const handler = new StreamHandler(
      ctx as any,
      { injectSystemMessage: vi.fn() } as any,
      { emitTaskProgress: vi.fn(), emitTaskStats: vi.fn() } as any,
    );

    await withRunTraceContext(run, async () => {
      const turn = handler.setupIteration(1, 'check', { startSpan: vi.fn() } as any);
      expect(turn).toMatchObject({
        traceId: run.traceId,
        sessionId: 'session-stream',
        turnId: ctx.turn.currentTurnId,
        toolCallId: null,
      });
      expect(getActiveRunTraceContext()).toEqual(turn);
    });
    expect(getActiveRunTraceContext()).toBeUndefined();
  });
});
