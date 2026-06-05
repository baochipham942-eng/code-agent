import { describe, expect, it, vi } from 'vitest';
import { StreamHandler } from '../../../src/main/agent/runtime/streamHandler';

vi.mock('../../../src/main/services/infra/logger', () => ({
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
      totalTokensUsed: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    };
    const handler = new StreamHandler(ctx as any, {} as any, {} as any);

    handler.emitModelResponse({
      type: 'text',
      content: 'done',
      usage: { inputTokens: 120, outputTokens: 7 },
    } as any, 42);

    expect(ctx.totalInputTokens).toBe(120);
    expect(ctx.totalOutputTokens).toBe(7);
    expect(ctx.totalTokensUsed).toBe(127);
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
      pendingRuntimeDiagnostics: ['diagnostic detail'],
      historyVisibility: 'meta',
      traceId: 'trace-1',
      currentTurnId: undefined,
      messageDeltaSeq: 99,
      turnStartTime: 0,
      toolsUsedInTurn: ['old-tool'],
      _researchModeActive: false,
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
});
