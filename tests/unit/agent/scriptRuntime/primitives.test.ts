// ============================================================================
// primitives.handleRpc Tests (P2-B：agent RPC 回传 spent)
//
// agent 调用落地后，响应里必须带 ctx.budget.spent()，worker 侧 budget.spent()/remaining()
// 镜像据此更新，脚本才能用 while(budget.remaining()>x) 动态收敛。
// ============================================================================

import { describe, it, expect, vi } from 'vitest';

const runAgentCallMock = vi.fn();
vi.mock('../../../../src/main/agent/scriptRuntime/agentBridge', () => ({
  runAgentCall: (...a: unknown[]) => runAgentCallMock(...a),
}));

import { handleRpc } from '../../../../src/main/agent/scriptRuntime/primitives';
import { BudgetTracker } from '../../../../src/main/agent/scriptRuntime/budget';
import type { ScriptRunContext } from '../../../../src/main/agent/scriptRuntime/agentBridge';

function makeCtx(budget: BudgetTracker): ScriptRunContext {
  return { runId: 'r', budget, emit: vi.fn(), now: () => 0 } as unknown as ScriptRunContext;
}

describe('handleRpc agent → spent', () => {
  it('returns the cumulative spent after the agent call', async () => {
    const budget = new BudgetTracker(1000);
    // 模拟 runAgentCall 把 outputTokens 计进预算
    runAgentCallMock.mockImplementation(async (_call: unknown, ctx: ScriptRunContext) => {
      ctx.budget.add(33);
      return 'result';
    });
    const res = await handleRpc({ id: 1, kind: 'agent', payload: { prompt: 'p' } }, makeCtx(budget));
    expect(res.ok).toBe(true);
    expect(res.result).toBe('result');
    expect(res.spent).toBe(33);
  });
});
