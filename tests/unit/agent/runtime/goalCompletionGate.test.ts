import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRunVerifyGate = vi.fn();
const mockRunReviewGate = vi.fn();

vi.mock('../../../../src/host/agent/goalVerifyGate', () => ({
  runVerifyGate: (...args: unknown[]) => mockRunVerifyGate(...args),
}));
vi.mock('../../../../src/host/agent/goalReviewGate', () => ({
  runReviewGate: (...args: unknown[]) => mockRunReviewGate(...args),
}));

import { handleGoalCompletionGate } from '../../../../src/host/agent/runtime/goalCompletionGate';
import type { RuntimeContext } from '../../../../src/host/agent/runtime/runtimeContext';
import type { ContextAssembly } from '../../../../src/host/agent/runtime/contextAssembly';

function makeCtx(goalModeOverrides: Record<string, unknown> = {}) {
  const goalMode = {
    isPending: vi.fn().mockReturnValue(true),
    requestCompletion: vi.fn(),
    clearCompletionRequest: vi.fn(),
    getVerifyCommand: vi.fn().mockReturnValue(undefined),
    getReviewCondition: vi.fn().mockReturnValue('代码无重复逻辑'),
    getGoal: vi.fn().mockReturnValue('重构 utils'),
    getSwarmTokensUsed: vi.fn().mockReturnValue(500),
    markMet: vi.fn(),
    markAborted: vi.fn(),
    // 三分支裁决（有界修复 + 到限放行）新增接口
    recordGateFailure: vi.fn().mockReturnValue(1),
    getGateFailureCount: vi.fn().mockReturnValue(0),
    isGateRepairExhausted: vi.fn().mockReturnValue(false),
    markMetDegraded: vi.fn(),
    isVerificationDegraded: vi.fn().mockReturnValue(false),
    ...goalModeOverrides,
  };
  const ctx = {
    goalMode,
    workingDirectory: '/tmp/test',
    sessionId: 's1',
    runAbortController: null,
    hookManager: undefined,
    modelConfig: { provider: 'zhipu', model: 'glm-5' },
    totalInputTokens: 1200,
    totalOutputTokens: 300,
    // 闸0（证据自证）打回预算标记为已耗尽 → 直通闸1/闸2，本文件只测后两闸语义
    goalEvidenceGateBounces: 99,
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

  it('评审判定 IMPOSSIBLE → markAborted 止损 + 强制无工具收尾解释（codex audit R1 修订）', async () => {
    mockRunReviewGate.mockResolvedValue({
      pass: false,
      parsed: true,
      impossible: true,
      reason: '条件依赖不存在且无法创建的资源。',
    });
    const { ctx, goalMode, contextAssembly } = makeCtx();

    const result = await handleGoalCompletionGate(ctx, contextAssembly, [completionCall], 7);

    // 返回 continue：让下一轮走 forceFinalResponse 无工具推理，向用户解释不可达原因
    expect(result).toBe('continue');
    expect(ctx.forceFinalResponseReason).toBeTruthy();
    expect(ctx.forceFinalResponsePrompt).toContain('不可达成');
    expect(goalMode.markAborted).toHaveBeenCalledWith(expect.stringContaining('不可达成'));
    expect(goalMode.markMet).not.toHaveBeenCalled();
    expect(ctx.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'goal_complete',
        data: expect.objectContaining({ status: 'aborted' }),
      }),
    );
  });

  it('IMPOSSIBLE 的 goal_complete 事件带真实 turns 与 tokensUsed（含 swarm 记账，codex audit R2 deferred）', async () => {
    mockRunReviewGate.mockResolvedValue({
      pass: false,
      parsed: true,
      impossible: true,
      reason: '条件依赖不存在且无法创建的资源。',
    });
    const { ctx, contextAssembly } = makeCtx();

    await handleGoalCompletionGate(ctx, contextAssembly, [completionCall], 7);

    expect(ctx.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'goal_complete',
        // turns = 当前轮次；tokensUsed = 主 agent 1200+300 + swarm 500
        data: expect.objectContaining({ status: 'aborted', turns: 7, tokensUsed: 2000 }),
      }),
    );
  });

  it('普通 FAIL 仍走 continue 重入路径', async () => {
    mockRunReviewGate.mockResolvedValue({ pass: false, parsed: true, reason: '还有重复' });
    const { ctx, goalMode, contextAssembly } = makeCtx();

    const result = await handleGoalCompletionGate(ctx, contextAssembly, [completionCall], 3);

    expect(result).toBe('continue');
    expect(goalMode.markAborted).not.toHaveBeenCalled();
    expect(goalMode.clearCompletionRequest).toHaveBeenCalled();
  });

  it('PASS 仍 markMet 收尾', async () => {
    mockRunReviewGate.mockResolvedValue({ pass: true, parsed: true, reason: 'ok' });
    const { ctx, goalMode, contextAssembly } = makeCtx();

    const result = await handleGoalCompletionGate(ctx, contextAssembly, [completionCall], 3);

    expect(result).toBe('break');
    expect(goalMode.markMet).toHaveBeenCalled();
  });

  it('--verify 通过时在 goal_gate 事件里带 VerificationEvidence refs', async () => {
    mockRunVerifyGate.mockResolvedValue({
      pass: true,
      exitCode: 0,
      output: 'ok',
      timedOut: false,
      command: 'npm test',
      cwd: '/tmp/test',
      durationMs: 18,
      stdoutTail: 'ok',
      stderrTail: '',
    });
    const { ctx, goalMode, contextAssembly } = makeCtx({
      getVerifyCommand: vi.fn().mockReturnValue('npm test'),
      getReviewCondition: vi.fn().mockReturnValue(undefined),
    });

    const result = await handleGoalCompletionGate(ctx, contextAssembly, [completionCall], 3);

    expect(result).toBe('break');
    expect(goalMode.markMet).toHaveBeenCalled();
    expect(ctx.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'goal_gate',
        data: expect.objectContaining({
          gate: 1,
          pass: true,
          verificationStatus: 'passed',
          evidenceRefs: expect.arrayContaining([
            expect.objectContaining({ source: 'VerificationRunner' }),
          ]),
        }),
      }),
    );
  });

  it('没有 verifyCommand 时完成消息标 not_run，不声称 fully verified', async () => {
    mockRunReviewGate.mockResolvedValue({ pass: true, parsed: true, reason: 'ok' });
    const { ctx, contextAssembly } = makeCtx();

    const result = await handleGoalCompletionGate(ctx, contextAssembly, [completionCall], 3);

    expect(result).toBe('break');
    expect(ctx.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'goal_gate',
        data: expect.objectContaining({
          gate: 1,
          verificationStatus: 'not_run',
          verificationCard: expect.objectContaining({
            status: 'not_run',
            requiredStatus: 'not_run',
          }),
        }),
      }),
    );
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('<goal-completed>'),
    );
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('verification status: not_run'),
    );
    expect(contextAssembly.injectSystemMessage).toHaveBeenCalledWith(
      expect.stringContaining('不标记为 fully verified'),
    );
  });
});
