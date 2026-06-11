import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRunVerifyGate = vi.fn();
const mockRunReviewGate = vi.fn();

vi.mock('../../../../src/main/agent/goalVerifyGate', () => ({
  runVerifyGate: (...args: unknown[]) => mockRunVerifyGate(...args),
}));
vi.mock('../../../../src/main/agent/goalReviewGate', () => ({
  runReviewGate: (...args: unknown[]) => mockRunReviewGate(...args),
}));

import { handleGoalCompletionGate } from '../../../../src/main/agent/runtime/goalCompletionGate';
import type { RuntimeContext } from '../../../../src/main/agent/runtime/runtimeContext';
import type { ContextAssembly } from '../../../../src/main/agent/runtime/contextAssembly';

function makeCtx(goalModeOverrides: Record<string, unknown> = {}) {
  const goalMode = {
    isPending: vi.fn().mockReturnValue(true),
    requestCompletion: vi.fn(),
    clearCompletionRequest: vi.fn(),
    getVerifyCommand: vi.fn().mockReturnValue(undefined),
    getReviewCondition: vi.fn().mockReturnValue('代码无重复逻辑'),
    getGoal: vi.fn().mockReturnValue('重构 utils'),
    markMet: vi.fn(),
    markAborted: vi.fn(),
    ...goalModeOverrides,
  };
  const ctx = {
    goalMode,
    workingDirectory: '/tmp/test',
    sessionId: 's1',
    runAbortController: null,
    hookManager: undefined,
    modelConfig: { provider: 'zhipu', model: 'glm-5' },
    onEvent: vi.fn(),
  } as unknown as RuntimeContext;
  const contextAssembly = {
    injectSystemMessage: vi.fn(),
  } as unknown as ContextAssembly;
  return { ctx, goalMode, contextAssembly };
}

const completionCall = { id: 'c1', name: 'attempt_completion', arguments: { summary: 'done' } };

describe('handleGoalCompletionGate — IMPOSSIBLE 主动止损 (roadmap 1.4)', () => {
  beforeEach(() => {
    mockRunVerifyGate.mockReset();
    mockRunReviewGate.mockReset();
  });

  it('评审判定 IMPOSSIBLE → markAborted 止损并 break，不再让模型空转', async () => {
    mockRunReviewGate.mockResolvedValue({
      pass: false,
      parsed: true,
      impossible: true,
      reason: '条件依赖不存在且无法创建的资源。',
    });
    const { ctx, goalMode, contextAssembly } = makeCtx();

    const result = await handleGoalCompletionGate(ctx, contextAssembly, [completionCall]);

    expect(result).toBe('break');
    expect(goalMode.markAborted).toHaveBeenCalledWith(expect.stringContaining('不可达成'));
    expect(goalMode.markMet).not.toHaveBeenCalled();
    expect(ctx.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'goal_complete',
        data: expect.objectContaining({ status: 'aborted' }),
      }),
    );
  });

  it('普通 FAIL 仍走 continue 重入路径', async () => {
    mockRunReviewGate.mockResolvedValue({ pass: false, parsed: true, reason: '还有重复' });
    const { ctx, goalMode, contextAssembly } = makeCtx();

    const result = await handleGoalCompletionGate(ctx, contextAssembly, [completionCall]);

    expect(result).toBe('continue');
    expect(goalMode.markAborted).not.toHaveBeenCalled();
    expect(goalMode.clearCompletionRequest).toHaveBeenCalled();
  });

  it('PASS 仍 markMet 收尾', async () => {
    mockRunReviewGate.mockResolvedValue({ pass: true, parsed: true, reason: 'ok' });
    const { ctx, goalMode, contextAssembly } = makeCtx();

    const result = await handleGoalCompletionGate(ctx, contextAssembly, [completionCall]);

    expect(result).toBe('break');
    expect(goalMode.markMet).toHaveBeenCalled();
  });
});
