// ============================================================================
// B6b-①：闸0 goal_gate 事件补 verdict（纯可观测性加法，闸行为零改动）
// ============================================================================
// 此前闸0 事件只带 pass 布尔：eval 侧无法区分「证据核验通过」与「打回预算耗尽
// 放行」（两者都 pass=true），只能去 pin reason 文案。本批把闸0 的三态映射到
// 闸1/闸2 既有的 GoalGateVerdict 词汇表：
//   pass → allow_finalize / bounce → repair_prompt / exhausted_release → 原样
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRunGoalEvidenceGate = vi.fn();
const mockRunReviewGate = vi.fn();

vi.mock('../../../../src/host/agent/runtime/goalEvidenceGate', () => ({
  runGoalEvidenceGate: (...args: unknown[]) => mockRunGoalEvidenceGate(...args),
}));
vi.mock('../../../../src/host/agent/goalReviewGate', () => ({
  runReviewGate: (...args: unknown[]) => mockRunReviewGate(...args),
}));
vi.mock('../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ appendToolExecutionComplete: vi.fn() }),
}));

import { handleGoalCompletionGate } from '../../../../src/host/agent/runtime/goalCompletionGate';
import type { RuntimeContext } from '../../../../src/host/agent/runtime/runtimeContext';
import type { ContextAssembly } from '../../../../src/host/agent/runtime/contextAssembly';

function makeCtx() {
  const goalMode = {
    isPending: vi.fn().mockReturnValue(true),
    requestCompletion: vi.fn(),
    clearCompletionRequest: vi.fn(),
    getVerifyCommand: vi.fn().mockReturnValue(undefined),
    getReviewCondition: vi.fn().mockReturnValue('产物内容正确'),
    getGoal: vi.fn().mockReturnValue('测试目标'),
    getSwarmTokensUsed: vi.fn().mockReturnValue(0),
    markMet: vi.fn(),
    markAborted: vi.fn(),
    recordGateFailure: vi.fn().mockReturnValue(1),
    getGateFailureCount: vi.fn().mockReturnValue(0),
    isGateRepairExhausted: vi.fn().mockReturnValue(false),
    markMetDegraded: vi.fn(),
    isVerificationDegraded: vi.fn().mockReturnValue(false),
  };
  const ctx = {
    goalMode,
    workingDirectory: '/tmp/test',
    sessionId: 's1',
    runAbortController: null,
    hookManager: undefined,
    modelConfig: { provider: 'zhipu', model: 'glm-5' },
    totalInputTokens: 100,
    totalOutputTokens: 50,
    messages: [],
    onEvent: vi.fn(),
  } as unknown as RuntimeContext;
  const contextAssembly = { injectSystemMessage: vi.fn() } as unknown as ContextAssembly;
  return { ctx, contextAssembly };
}

const completionCall = { id: 'c1', name: 'attempt_completion', arguments: { summary: 'done' } };

function gateZeroEvents(ctx: RuntimeContext) {
  return (ctx.onEvent as ReturnType<typeof vi.fn>).mock.calls
    .map(([event]) => event)
    .filter((e: { type: string; data?: { gate?: number } }) => e.type === 'goal_gate' && e.data?.gate === 0);
}

describe('闸0 goal_gate 事件带 verdict（映射到 GoalGateVerdict 词汇表）', () => {
  beforeEach(() => {
    mockRunGoalEvidenceGate.mockReset();
    mockRunReviewGate.mockReset();
    mockRunReviewGate.mockResolvedValue({ pass: true, parsed: true, impossible: false, reason: 'ok' });
  });

  it('证据核验通过 → pass:true + verdict allow_finalize', async () => {
    mockRunGoalEvidenceGate.mockReturnValue({ verdict: 'pass', reason: 'ok', evidenceRefs: [] });
    const { ctx, contextAssembly } = makeCtx();
    await handleGoalCompletionGate(ctx, contextAssembly, [completionCall], 3);
    const events = gateZeroEvents(ctx);
    expect(events).toHaveLength(1);
    expect(events[0].data.pass).toBe(true);
    expect(events[0].data.verdict).toBe('allow_finalize');
  });

  it('证据不足打回 → pass:false + verdict repair_prompt，返回 continue', async () => {
    mockRunGoalEvidenceGate.mockReturnValue({
      verdict: 'bounce', reason: 'missing evidence', feedback: 'gate feedback', evidenceRefs: [],
    });
    const { ctx, contextAssembly } = makeCtx();
    const result = await handleGoalCompletionGate(ctx, contextAssembly, [completionCall], 3);
    expect(result).toBe('continue');
    const events = gateZeroEvents(ctx);
    expect(events).toHaveLength(1);
    expect(events[0].data.pass).toBe(false);
    expect(events[0].data.verdict).toBe('repair_prompt');
  });

  it('打回预算耗尽放行 → pass:true + verdict exhausted_release（与「核验通过」可区分）', async () => {
    mockRunGoalEvidenceGate.mockReturnValue({
      verdict: 'exhausted_release', reason: 'bounces exhausted', evidenceRefs: [],
    });
    const { ctx, contextAssembly } = makeCtx();
    await handleGoalCompletionGate(ctx, contextAssembly, [completionCall], 3);
    const events = gateZeroEvents(ctx);
    expect(events).toHaveLength(1);
    expect(events[0].data.pass).toBe(true);
    expect(events[0].data.verdict).toBe('exhausted_release');
  });
});
