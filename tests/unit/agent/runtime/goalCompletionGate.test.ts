import { ArtifactState } from '../../../../src/host/agent/runtime/artifactState';
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
import { ControlState } from '../../../../src/host/agent/runtime/controlState';
import { RunStatsState } from '../../../../src/host/agent/runtime/runStatsState';

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
    artifact: ArtifactState.forTest(),
    goalMode,
    workingDirectory: '/tmp/test',
    sessionId: 's1',
    control: ControlState.forTest(),
    hookManager: undefined,
    modelConfig: { provider: 'zhipu', model: 'glm-5' },
    stats: RunStatsState.forTest({ totalInputTokens: 1200, totalOutputTokens: 300 } as never),
    // 闸0（证据自证）打回预算标记为已耗尽 → 直通闸1/闸2，本文件只测后两闸语义
    goalEvidenceState: { bounces: 99 },
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
    expect(ctx.control.forceFinalResponseReason).toBeTruthy();
    expect(ctx.control.forceFinalResponsePrompt).toContain('不可达成');
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

describe('handleGoalCompletionGate — 闸2 评审基础设施故障（unverifiable，infra 错误不许伪装成评审不过）', () => {
  beforeEach(() => {
    mockRunVerifyGate.mockReset();
    mockRunReviewGate.mockReset();
  });

  const unverifiableReview = {
    pass: false,
    parsed: false,
    unverifiable: true,
    reason: '评审基础设施不可用：Invalid API Key',
  };

  it('unverifiable → 不烧修复预算：recordGateFailure(2) 不被调用，也不注入评审修复反馈', async () => {
    mockRunReviewGate.mockResolvedValue(unverifiableReview);
    const { ctx, goalMode, contextAssembly } = makeCtx();

    const result = await handleGoalCompletionGate(ctx, contextAssembly, [completionCall], 5);

    expect(result).toBe('continue');
    expect(goalMode.recordGateFailure).not.toHaveBeenCalled();
    // 不注入 <goal-review-failed> 这类"评审不过"的误导反馈
    expect(contextAssembly.injectSystemMessage).not.toHaveBeenCalled();
  });

  it('unverifiable → markMetDegraded 诚实收尾，degradedReason 带真实 infra 错误', async () => {
    mockRunReviewGate.mockResolvedValue(unverifiableReview);
    const { ctx, goalMode, contextAssembly } = makeCtx();

    await handleGoalCompletionGate(ctx, contextAssembly, [completionCall], 5);

    expect(goalMode.markMetDegraded).toHaveBeenCalledWith(expect.stringContaining('Invalid API Key'));
    expect(goalMode.markMet).not.toHaveBeenCalled();
    expect(goalMode.markAborted).not.toHaveBeenCalled();
    expect(goalMode.clearCompletionRequest).toHaveBeenCalled();
  });

  it('unverifiable → goal_complete 事件 met + degraded（不许静默 markMet 假绿，也不许 aborted 丢产物）', async () => {
    mockRunReviewGate.mockResolvedValue(unverifiableReview);
    const { ctx, contextAssembly } = makeCtx();

    await handleGoalCompletionGate(ctx, contextAssembly, [completionCall], 5);

    expect(ctx.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'goal_complete',
        data: expect.objectContaining({
          status: 'met',
          degraded: true,
          degradedReason: expect.stringContaining('Invalid API Key'),
          turns: 5,
          tokensUsed: 2000,
        }),
      }),
    );
  });

  it('unverifiable → gate:2 观测事件带 verificationStatus not_run + reason（与评审 FAIL 可区分）', async () => {
    mockRunReviewGate.mockResolvedValue(unverifiableReview);
    const { ctx, contextAssembly } = makeCtx();

    await handleGoalCompletionGate(ctx, contextAssembly, [completionCall], 5);

    expect(ctx.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'goal_gate',
        data: expect.objectContaining({
          gate: 2,
          verificationStatus: 'not_run',
          reason: expect.stringContaining('Invalid API Key'),
        }),
      }),
    );
  });

  it('unverifiable → 终态 gate:2 事件带 attempt（对齐 exhausted_release 的终态事件形状，Gemini R1-M2）', async () => {
    mockRunReviewGate.mockResolvedValue(unverifiableReview);
    const { ctx, contextAssembly } = makeCtx();

    await handleGoalCompletionGate(ctx, contextAssembly, [completionCall], 5);

    expect(ctx.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'goal_gate',
        data: expect.objectContaining({
          gate: 2,
          pass: false,
          verificationStatus: 'not_run',
          attempt: expect.any(Number),
        }),
      }),
    );
  });

  it('unverifiable → forceFinalResponse 无工具诚实收尾（对齐 exhausted_release 分支）', async () => {
    mockRunReviewGate.mockResolvedValue(unverifiableReview);
    const { ctx, contextAssembly } = makeCtx();

    const result = await handleGoalCompletionGate(ctx, contextAssembly, [completionCall], 5);

    expect(result).toBe('continue');
    expect(ctx.control.forceFinalResponseReason).toBeTruthy();
    expect(ctx.control.forceFinalResponsePrompt).toContain('Invalid API Key');
  });

  it('普通评审 FAIL（非 unverifiable）仍走修复预算路径（行为不回退）', async () => {
    mockRunReviewGate.mockResolvedValue({ pass: false, parsed: true, reason: '还有重复' });
    const { ctx, goalMode, contextAssembly } = makeCtx();

    const result = await handleGoalCompletionGate(ctx, contextAssembly, [completionCall], 5);

    expect(result).toBe('continue');
    expect(goalMode.recordGateFailure).toHaveBeenCalledWith(2);
    expect(goalMode.markMetDegraded).not.toHaveBeenCalled();
  });
});

describe('handleGoalCompletionGate — 闸1 验证基础设施故障（infraFailure，本地执行环境不许伪装成验证不过）', () => {
  beforeEach(() => {
    mockRunVerifyGate.mockReset();
    mockRunReviewGate.mockReset();
  });

  // 地面真值（tests/unit/agent/goalVerifyGate.spawnFailure.test.ts 实测）：
  // cwd 不存在/不是目录、解释器无执行权限等 OS 级 spawn 失败时，runVerifyGate
  // 产出 exitCode:null + spawnFailed:true，与"进程跑了但退出码非 0"结构性可区分。
  const spawnFailureResult = {
    pass: false,
    exitCode: null,
    output: '验证命令启动失败: spawn /bin/sh ENOENT',
    timedOut: false,
    command: 'npm test',
    cwd: '/tmp/does-not-exist',
    durationMs: 2,
    stdoutTail: '',
    stderrTail: '',
    spawnFailed: true,
  };

  function makeInfraCtx() {
    return makeCtx({
      getVerifyCommand: vi.fn().mockReturnValue('npm test'),
      getReviewCondition: vi.fn().mockReturnValue(undefined),
    });
  }

  it('infraFailure → 不烧修复预算：recordGateFailure(1) 不被调用，也不注入 <goal-verify-failed> 误导反馈', async () => {
    mockRunVerifyGate.mockResolvedValue(spawnFailureResult);
    const { ctx, goalMode, contextAssembly } = makeInfraCtx();

    const result = await handleGoalCompletionGate(ctx, contextAssembly, [completionCall], 5);

    expect(result).toBe('continue');
    expect(goalMode.recordGateFailure).not.toHaveBeenCalled();
    expect(contextAssembly.injectSystemMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('<goal-verify-failed>'),
    );
  });

  it('infraFailure → markMetDegraded 诚实收尾，degradedReason 带真实 spawn 错误', async () => {
    mockRunVerifyGate.mockResolvedValue(spawnFailureResult);
    const { ctx, goalMode, contextAssembly } = makeInfraCtx();

    await handleGoalCompletionGate(ctx, contextAssembly, [completionCall], 5);

    expect(goalMode.markMetDegraded).toHaveBeenCalledWith(expect.stringContaining('ENOENT'));
    expect(goalMode.markMet).not.toHaveBeenCalled();
    expect(goalMode.markAborted).not.toHaveBeenCalled();
    expect(goalMode.clearCompletionRequest).toHaveBeenCalled();
  });

  it('infraFailure → goal_complete 事件 met + degraded（不许静默 markMet 假绿，也不许 aborted 丢产物）', async () => {
    mockRunVerifyGate.mockResolvedValue(spawnFailureResult);
    const { ctx, contextAssembly } = makeInfraCtx();

    await handleGoalCompletionGate(ctx, contextAssembly, [completionCall], 5);

    expect(ctx.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'goal_complete',
        data: expect.objectContaining({
          status: 'met',
          degraded: true,
          degradedReason: expect.stringContaining('ENOENT'),
          turns: 5,
          tokensUsed: 2000,
        }),
      }),
    );
  });

  it('infraFailure → gate:1 观测事件（初始+终态）都带 verificationStatus not_run（与验证 FAIL 可区分）', async () => {
    mockRunVerifyGate.mockResolvedValue(spawnFailureResult);
    const { ctx, contextAssembly } = makeInfraCtx();

    await handleGoalCompletionGate(ctx, contextAssembly, [completionCall], 5);

    const gate1Events = (ctx.onEvent as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0])
      .filter((event) => event.type === 'goal_gate' && event.data.gate === 1);
    expect(gate1Events.length).toBe(2);
    for (const event of gate1Events) {
      expect(event.data.pass).toBe(false);
      expect(event.data.verificationStatus).toBe('not_run');
    }
  });

  it('infraFailure → 初始 gate:1 事件里 verificationCard.status/requiredStatus 也一并盖成 not_run（不能 verificationStatus 说 not_run 但卡片仍渲染 failed 红色态）', async () => {
    mockRunVerifyGate.mockResolvedValue(spawnFailureResult);
    const { ctx, contextAssembly } = makeInfraCtx();

    await handleGoalCompletionGate(ctx, contextAssembly, [completionCall], 5);

    const initialGate1Event = (ctx.onEvent as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0])
      .find((event) => event.type === 'goal_gate' && event.data.gate === 1 && event.data.verificationCard);
    expect(initialGate1Event).toBeTruthy();
    expect(initialGate1Event.data.verificationCard.status).toBe('not_run');
    expect(initialGate1Event.data.verificationCard.requiredStatus).toBe('not_run');
  });

  it('infraFailure → forceFinalResponse 无工具诚实收尾（对齐闸2 unverifiable 分支）', async () => {
    mockRunVerifyGate.mockResolvedValue(spawnFailureResult);
    const { ctx, contextAssembly } = makeInfraCtx();

    const result = await handleGoalCompletionGate(ctx, contextAssembly, [completionCall], 5);

    expect(result).toBe('continue');
    expect(ctx.control.forceFinalResponseReason).toBeTruthy();
    expect(ctx.control.forceFinalResponsePrompt).toContain('ENOENT');
  });

  it('普通验证 FAIL（非 infraFailure，退出码非 0）仍走修复预算路径（行为不回退）', async () => {
    mockRunVerifyGate.mockResolvedValue({
      pass: false,
      exitCode: 1,
      output: 'test failed',
      timedOut: false,
      command: 'npm test',
      cwd: '/tmp/test',
      durationMs: 12,
      stdoutTail: 'test failed',
      stderrTail: '',
      spawnFailed: false,
    });
    const { ctx, goalMode, contextAssembly } = makeInfraCtx();

    const result = await handleGoalCompletionGate(ctx, contextAssembly, [completionCall], 5);

    expect(result).toBe('continue');
    expect(goalMode.recordGateFailure).toHaveBeenCalledWith(1);
    expect(goalMode.markMetDegraded).not.toHaveBeenCalled();
  });

  it('命令未找到（exit 127，classify=dependency_missing）不算 infra：模型可能自行装依赖修复，仍走修复预算路径', async () => {
    mockRunVerifyGate.mockResolvedValue({
      pass: false,
      exitCode: 127,
      output: '/bin/sh: nonexistent-cmd: command not found',
      timedOut: false,
      command: 'nonexistent-cmd',
      cwd: '/tmp/test',
      durationMs: 5,
      stdoutTail: '',
      stderrTail: '/bin/sh: nonexistent-cmd: command not found',
      spawnFailed: false,
    });
    const { ctx, goalMode, contextAssembly } = makeCtx({
      getVerifyCommand: vi.fn().mockReturnValue('nonexistent-cmd'),
      getReviewCondition: vi.fn().mockReturnValue(undefined),
    });

    const result = await handleGoalCompletionGate(ctx, contextAssembly, [completionCall], 5);

    expect(result).toBe('continue');
    expect(goalMode.recordGateFailure).toHaveBeenCalledWith(1);
    expect(goalMode.markMetDegraded).not.toHaveBeenCalled();
  });
});
