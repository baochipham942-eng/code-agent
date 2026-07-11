// ============================================================================
// primitives.handleRpc Tests (P2-B：agent RPC 回传 spent)
//
// agent 调用落地后，响应里必须带 ctx.budget.spent()，worker 侧 budget.spent()/remaining()
// 镜像据此更新，脚本才能用 while(budget.remaining()>x) 动态收敛。
// ============================================================================

import { describe, it, expect, vi } from 'vitest';

const runAgentCallMock = vi.fn();
vi.mock('../../../../src/host/agent/scriptRuntime/agentBridge', () => ({
  runAgentCall: (...a: unknown[]) => runAgentCallMock(...a),
}));

import { handleRpc } from '../../../../src/host/agent/scriptRuntime/primitives';
import { BudgetTracker } from '../../../../src/host/agent/scriptRuntime/budget';
import type { ScriptRunContext } from '../../../../src/host/agent/scriptRuntime/agentBridge';

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

  it('returns spent on the error response too, so the worker mirror does not stall (HIGH#2)', async () => {
    const budget = new BudgetTracker(1000);
    // 模拟：调用消耗了 token 但最终抛错（失败路径已记账，再抛）
    runAgentCallMock.mockImplementation(async (_call: unknown, ctx: ScriptRunContext) => {
      ctx.budget.add(21);
      throw new Error('agent boom');
    });
    const res = await handleRpc({ id: 2, kind: 'agent', payload: { prompt: 'p' } }, makeCtx(budget));
    expect(res.ok).toBe(false);
    expect(res.spent).toBe(21);
  });
});

describe('handleRpc credential redaction', () => {
  it('redacts credentials before phase/log events leave the Host dispatcher', async () => {
    const ctx = makeCtx(new BudgetTracker(1000));
    await handleRpc({ id: 3, kind: 'log', payload: { message: 'Bearer abcdefghijklmnop' } }, ctx);
    expect(JSON.stringify((ctx.emit as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('abcdefghijklmnop');
  });
});
