// ============================================================================
// Swarm Goal（P4）单测 — 预算双向打通 + allowSwarm 默认值 + 集成胶水
// 设计见 docs/designs/swarm-goal.md §4
// ============================================================================

import { describe, expect, it } from 'vitest';
import { buildGoalContract, GoalModeController } from '../../../src/host/agent/goalModeController';
import {
  applySwarmBudgetClamp,
  recordSwarmSpend,
  goalTokensUsedWithSwarm,
  maybeInjectSwarmGuidance,
  type SwarmGoalRuntimeView,
} from '../../../src/host/agent/runtime/swarmGoalIntegration';
import { SWARM_GOAL } from '../../../src/shared/constants';
import type { ToolCall, ToolResult } from '../../../src/shared/contract';

function makeController(opts?: { tokenBudget?: number; allowSwarm?: boolean }): GoalModeController {
  return new GoalModeController(
    buildGoalContract({
      goal: '把所有测试修绿',
      verifyCommand: 'npm test',
      tokenBudget: opts?.tokenBudget ?? 1_000_000,
      allowSwarm: opts?.allowSwarm,
    }),
  );
}

function workflowCall(budgetTokens?: number): ToolCall {
  return {
    id: 'tc-wf-1',
    name: 'workflow',
    arguments: budgetTokens === undefined ? { script: 'return 1' } : { script: 'return 1', budgetTokens },
  };
}

describe('GoalContract.allowSwarm 默认值', () => {
  it('交互式 /goal 缺省 → allowSwarm=true', () => {
    expect(makeController().allowsSwarm()).toBe(true);
  });
  it('advance 路径显式传 false → allowSwarm=false', () => {
    expect(makeController({ allowSwarm: false }).allowsSwarm()).toBe(false);
  });
});

describe('clampSwarmBudget（下行钳制）', () => {
  it('模型自报值超过剩余预算×0.8 → 压到上限', () => {
    const c = makeController({ tokenBudget: 1_000_000 });
    // 主 agent 已用 0，剩余 1M，上限 = 800k
    expect(c.clampSwarmBudget(900_000, 0)).toBe(800_000);
  });
  it('模型自报值低于上限 → 取模型自报值', () => {
    const c = makeController({ tokenBudget: 1_000_000 });
    expect(c.clampSwarmBudget(100_000, 0)).toBe(100_000);
  });
  it('模型未报 budgetTokens → 用剩余预算×0.8 作为兜底上限', () => {
    const c = makeController({ tokenBudget: 1_000_000 });
    expect(c.clampSwarmBudget(undefined, 0)).toBe(Math.floor(1_000_000 * SWARM_GOAL.MAX_BUDGET_FRACTION));
  });
  it('扣除主 agent 已用消耗后再算剩余', () => {
    const c = makeController({ tokenBudget: 1_000_000 });
    // 主用 500k，剩余 500k，上限 400k
    expect(c.clampSwarmBudget(900_000, 500_000)).toBe(400_000);
  });
  it('扣除已记账的 swarm 消耗后再算剩余', () => {
    const c = makeController({ tokenBudget: 1_000_000 });
    c.recordSwarmTokens(300_000);
    // 主 100k + swarm 300k 已用，剩余 600k，上限 480k
    expect(c.clampSwarmBudget(900_000, 100_000)).toBe(480_000);
  });
  it('剩余预算耗尽 → clamp 到 0（调用方应据此拒绝扇出）', () => {
    const c = makeController({ tokenBudget: 100_000 });
    expect(c.clampSwarmBudget(50_000, 100_000)).toBe(0);
  });
});

describe('recordSwarmTokens（上行记账）', () => {
  it('累加正数', () => {
    const c = makeController();
    c.recordSwarmTokens(100);
    c.recordSwarmTokens(50);
    expect(c.getSwarmTokensUsed()).toBe(150);
  });
  it('防御 undefined / NaN / 负数 → 跳过不记', () => {
    const c = makeController();
    c.recordSwarmTokens(undefined);
    c.recordSwarmTokens(NaN);
    c.recordSwarmTokens(-100);
    c.recordSwarmTokens('200' as unknown);
    expect(c.getSwarmTokensUsed()).toBe(0);
  });
});

describe('evaluateFallback 计入 swarm 消耗（闸3）', () => {
  it('主 agent 未超预算，但加上 swarm 消耗后超 → 触发闸3', () => {
    const c = makeController({ tokenBudget: 1_000_000 });
    c.recordSwarmTokens(600_000);
    // 主 500k + swarm 600k = 1.1M > 1M
    const r = c.evaluateFallback({ turn: 1, tokensUsed: 500_000 });
    expect(r.stop).toBe(true);
    expect(r.reason).toContain('swarm');
  });
  it('主 + swarm 仍在预算内 → 不触发', () => {
    const c = makeController({ tokenBudget: 1_000_000 });
    c.recordSwarmTokens(100_000);
    expect(c.evaluateFallback({ turn: 1, tokensUsed: 500_000 }).stop).toBe(false);
  });
});

describe('applySwarmBudgetClamp（集成胶水：dispatch 前 clamp）', () => {
  function view(c: GoalModeController, main = 0): SwarmGoalRuntimeView {
    return { goalMode: c, totalInputTokens: main, totalOutputTokens: 0 };
  }

  it('goal mode + allowSwarm → workflow 调用的 budgetTokens 被钳制', () => {
    const c = makeController({ tokenBudget: 1_000_000 });
    const call = workflowCall(900_000);
    applySwarmBudgetClamp(view(c), [call]);
    expect(call.arguments.budgetTokens).toBe(800_000);
  });
  it('allowSwarm=false → 不钳制（advance goal run 本就不预加载 workflow）', () => {
    const c = makeController({ tokenBudget: 1_000_000, allowSwarm: false });
    const call = workflowCall(900_000);
    applySwarmBudgetClamp(view(c), [call]);
    expect(call.arguments.budgetTokens).toBe(900_000);
  });
  it('非 workflow 工具 → 不动其参数', () => {
    const c = makeController();
    const call: ToolCall = { id: 't1', name: 'Read', arguments: { path: 'a.ts' } };
    applySwarmBudgetClamp(view(c), [call]);
    expect(call.arguments).toEqual({ path: 'a.ts' });
  });
  it('无 goalMode → no-op', () => {
    const call = workflowCall(900_000);
    applySwarmBudgetClamp({ totalInputTokens: 0, totalOutputTokens: 0 }, [call]);
    expect(call.arguments.budgetTokens).toBe(900_000);
  });
});

describe('recordSwarmSpend（集成胶水：执行后记账）', () => {
  it('从 workflow 结果 metadata.tokensSpent 提取并记账', () => {
    const c = makeController();
    const call = workflowCall();
    const result: ToolResult = { toolCallId: call.id, success: true, metadata: { tokensSpent: 12_345 } };
    recordSwarmSpend(c, [call], [result]);
    expect(c.getSwarmTokensUsed()).toBe(12_345);
  });
  it('失败结果也记账（token 已真实花掉）', () => {
    const c = makeController();
    const call = workflowCall();
    const result: ToolResult = { toolCallId: call.id, success: false, metadata: { tokensSpent: 999 } };
    recordSwarmSpend(c, [call], [result]);
    expect(c.getSwarmTokensUsed()).toBe(999);
  });
  it('结果缺 metadata → 安全跳过', () => {
    const c = makeController();
    const call = workflowCall();
    recordSwarmSpend(c, [call], [{ toolCallId: call.id, success: true }]);
    expect(c.getSwarmTokensUsed()).toBe(0);
  });
});

describe('goalTokensUsedWithSwarm（展示用加总）', () => {
  it('= 主 input + 主 output + swarm 记账', () => {
    const c = makeController();
    c.recordSwarmTokens(5000);
    expect(goalTokensUsedWithSwarm({ goalMode: c, totalInputTokens: 1000, totalOutputTokens: 2000 })).toBe(8000);
  });
  it('无 goalMode → 仅主消耗', () => {
    expect(goalTokensUsedWithSwarm({ totalInputTokens: 1000, totalOutputTokens: 2000 })).toBe(3000);
  });
});

describe('maybeInjectSwarmGuidance（首轮注入）', () => {
  it('首轮 + allowSwarm → 注入引导', () => {
    const c = makeController();
    let injected = '';
    maybeInjectSwarmGuidance({ goalMode: c }, (m) => { injected = m; }, 1);
    expect(injected).toContain('<goal-swarm-guidance>');
  });
  it('非首轮 → 不注入', () => {
    const c = makeController();
    let injected = '';
    maybeInjectSwarmGuidance({ goalMode: c }, (m) => { injected = m; }, 2);
    expect(injected).toBe('');
  });
  it('allowSwarm=false → 不注入', () => {
    const c = makeController({ allowSwarm: false });
    let injected = '';
    maybeInjectSwarmGuidance({ goalMode: c }, (m) => { injected = m; }, 1);
    expect(injected).toBe('');
  });
});
