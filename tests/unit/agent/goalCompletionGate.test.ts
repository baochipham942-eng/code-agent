// ============================================================================
// goalCompletionGate 三分支裁决单测 — allow_finalize / repair_prompt / exhausted_release
// 语义：验证失败给有界修复机会（GATE_REPAIR_MAX_ATTEMPTS），到限放行收尾但带
// 降级标记（完成但验证未全过），绝不无限阻塞；每次裁决落 turnTrace + 执行账本。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGoalContract, GoalModeController } from '../../../src/host/agent/goalModeController';
import { GOAL_MODE } from '../../../src/shared/constants';
import type { VerificationEvidence } from '../../../src/host/agent/verification';

const runVerificationPlanMock = vi.fn();
const runReviewGateMock = vi.fn();
const appendToolExecutionCompleteMock = vi.fn();

vi.mock('../../../src/host/agent/verification', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/agent/verification')>();
  return {
    ...actual,
    runVerificationPlan: (...args: unknown[]) => runVerificationPlanMock(...args),
  };
});

vi.mock('../../../src/host/agent/goalReviewGate', () => ({
  runReviewGate: (...args: unknown[]) => runReviewGateMock(...args),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    appendToolExecutionComplete: (...args: unknown[]) => appendToolExecutionCompleteMock(...args),
  }),
}));

import { handleGoalCompletionGate } from '../../../src/host/agent/runtime/goalCompletionGate';

function failedEvidence(): VerificationEvidence {
  return {
    status: 'failed',
    failureType: 'test',
    summary: 'test: npm test exited 1.',
    plan: {
      cwd: '/tmp/w', goal: 'g', verifyCommand: 'npm test',
      changedFiles: [], packageScripts: [], required: [], optional: [], skippedChecks: [],
    },
    commandResults: [{
      id: 'goal-contract:verifyCommand', command: 'npm test', cwd: '/tmp/w', required: true,
      kind: 'goal_contract', reason: 'Goal contract verifyCommand.', pass: false, exitCode: 1,
      durationMs: 10, timedOut: false, stdoutTail: '', stderrTail: 'FAIL', output: '1 test failed',
      evidenceRef: { id: 'ev1', kind: 'test', ref: 'x', source: 's', state: 'fresh', redactionStatus: 'clean', capturedAtMs: 1 } as never,
    }],
    skippedChecks: [],
    evidenceRefs: [],
  };
}

function passedEvidence(): VerificationEvidence {
  const e = failedEvidence();
  return {
    ...e,
    status: 'passed',
    failureType: undefined,
    summary: 'Verification passed (1 command).',
    commandResults: [{ ...e.commandResults[0], pass: true, exitCode: 0 }],
  };
}

interface TestHarness {
  ctx: Record<string, unknown> & {
    goalMode: GoalModeController;
    forceFinalResponseReason?: string;
    forceFinalResponsePrompt?: string;
  };
  contextAssembly: { injectSystemMessage: ReturnType<typeof vi.fn> };
  events: Array<{ type: string; data: Record<string, unknown> }>;
  run: () => Promise<'continue' | 'break' | null>;
}

function harness(opts?: { reviewCondition?: string }): TestHarness {
  const goalMode = new GoalModeController(buildGoalContract({
    goal: '修完所有测试',
    verifyCommand: 'npm test',
    reviewCondition: opts?.reviewCondition,
    tokenBudget: 1_000_000,
    maxTurns: 100,
  }));
  const events: TestHarness['events'] = [];
  const contextAssembly = { injectSystemMessage: vi.fn() };
  const ctx: TestHarness['ctx'] = {
    goalMode,
    workingDirectory: '/tmp/w',
    // 闸0（证据自证）打回预算标记为已耗尽 → 直通闸1/闸2，本文件只测三分支裁决
    goalEvidenceGateBounces: 99,
    sessionId: 'sess-1',
    onEvent: (e: { type: string; data: Record<string, unknown> }) => events.push(e),
    turnTrace: { record: vi.fn() },
    modelConfig: {},
  };
  const toolCalls = [{ id: 't1', name: 'attempt_completion', arguments: { summary: 'done' } }];
  return {
    ctx, contextAssembly, events,
    run: () => handleGoalCompletionGate(
      ctx as never, contextAssembly as never, toolCalls as never, 3,
    ),
  };
}

beforeEach(() => {
  runVerificationPlanMock.mockReset();
  runReviewGateMock.mockReset();
  appendToolExecutionCompleteMock.mockReset();
});

describe('分支1 allow_finalize — 验证通过', () => {
  it('闸1 过 → break，goal met 无降级，裁决落执行账本', async () => {
    runVerificationPlanMock.mockResolvedValue(passedEvidence());
    const h = harness();
    expect(await h.run()).toBe('break');
    expect(h.ctx.goalMode.getStatus()).toBe('met');
    expect(h.ctx.goalMode.isVerificationDegraded()).toBe(false);
    const verdicts = appendToolExecutionCompleteMock.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(verdicts.some((v) => String(v.summary).includes('allow_finalize'))).toBe(true);
  });
});

describe('分支2 repair_prompt — 失败且修复预算未耗尽', () => {
  it('闸1 首败 → continue，注入含修复机会计数的失败输出，goal 仍 pending', async () => {
    runVerificationPlanMock.mockResolvedValue(failedEvidence());
    const h = harness();
    expect(await h.run()).toBe('continue');
    expect(h.ctx.goalMode.isPending()).toBe(true);
    expect(h.ctx.goalMode.getGateFailureCount(1)).toBe(1);
    const injected = h.contextAssembly.injectSystemMessage.mock.calls[0][0] as string;
    expect(injected).toContain('goal-verify-failed');
    expect(injected).toContain(`1/${GOAL_MODE.GATE_REPAIR_MAX_ATTEMPTS}`);
    const verdicts = appendToolExecutionCompleteMock.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(verdicts.some((v) => String(v.summary).includes('repair_prompt'))).toBe(true);
  });
});

describe('分支3 exhausted_release — 到限放行，绝不无限阻塞', () => {
  it('闸1 连败至上限 → 放行：met + 降级标记 + forceFinalResponse 要求诚实收尾', async () => {
    runVerificationPlanMock.mockResolvedValue(failedEvidence());
    const h = harness();
    for (let i = 0; i < GOAL_MODE.GATE_REPAIR_MAX_ATTEMPTS; i++) {
      expect(await h.run()).toBe('continue');
    }
    expect(h.ctx.goalMode.getStatus()).toBe('met');
    expect(h.ctx.goalMode.isVerificationDegraded()).toBe(true);
    expect(h.ctx.forceFinalResponseReason).toBe('goal-verify-exhausted');
    expect(h.ctx.forceFinalResponsePrompt).toContain('goal-verify-exhausted');
    const verdicts = appendToolExecutionCompleteMock.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(verdicts.some((v) => String(v.summary).includes('exhausted_release'))).toBe(true);
    const gateEvents = h.events.filter((e) => e.type === 'goal_gate');
    expect(gateEvents.some((e) => e.data.verdict === 'exhausted_release')).toBe(true);
    // 终态事件在闸内立即发出（codex audit M1）：final 推理失败也不留"永远 running"
    const completeEvents = h.events.filter((e) => e.type === 'goal_complete');
    expect(completeEvents).toHaveLength(1);
    expect(completeEvents[0].data).toMatchObject({ status: 'met', degraded: true });
  });

  it('放行后 goal 不再 pending，不会继续拦截下一轮 attempt_completion', async () => {
    runVerificationPlanMock.mockResolvedValue(failedEvidence());
    const h = harness();
    for (let i = 0; i < GOAL_MODE.GATE_REPAIR_MAX_ATTEMPTS; i++) await h.run();
    expect(await h.run()).toBe(null);
  });
});

describe('闸2 软评审有独立修复预算', () => {
  it('闸1 过、闸2 连败至上限 → 同样到限放行', async () => {
    runVerificationPlanMock.mockResolvedValue(passedEvidence());
    runReviewGateMock.mockResolvedValue({ pass: false, reason: '文案不达标', impossible: false });
    const h = harness({ reviewCondition: '文案要亲切' });
    for (let i = 0; i < GOAL_MODE.GATE_REPAIR_MAX_ATTEMPTS; i++) {
      expect(await h.run()).toBe('continue');
    }
    expect(h.ctx.goalMode.getStatus()).toBe('met');
    expect(h.ctx.goalMode.isVerificationDegraded()).toBe(true);
  });

  it('每闸独立预算：闸1 失败 1 次修好后闸2 首败不放行，闸2 仍有完整修复机会（skeptic M2）', async () => {
    const h = harness({ reviewCondition: '文案要亲切' });
    // 第 1 轮：闸1 失败（消耗闸1 预算 1 次）
    runVerificationPlanMock.mockResolvedValue(failedEvidence());
    expect(await h.run()).toBe('continue');
    // 第 2 轮：闸1 修好通过，闸2 首败——不应放行（闸2 自己的预算才用 1 次）
    runVerificationPlanMock.mockResolvedValue(passedEvidence());
    runReviewGateMock.mockResolvedValue({ pass: false, reason: '文案不达标', impossible: false });
    expect(await h.run()).toBe('continue');
    expect(h.ctx.goalMode.isPending()).toBe(true);
    expect(h.ctx.goalMode.isVerificationDegraded()).toBe(false);
    expect(h.ctx.goalMode.getGateFailureCount(2)).toBe(1);
  });

  it('闸2 IMPOSSIBLE 分支不受修复预算影响，仍走主动止损 aborted', async () => {
    runVerificationPlanMock.mockResolvedValue(passedEvidence());
    runReviewGateMock.mockResolvedValue({ pass: false, reason: '前置条件缺失', impossible: true });
    const h = harness({ reviewCondition: '需要外部 API key' });
    expect(await h.run()).toBe('continue');
    expect(h.ctx.goalMode.getStatus()).toBe('aborted');
    expect(h.ctx.goalMode.isVerificationDegraded()).toBe(false);
  });
});
