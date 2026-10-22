// ============================================================================
// N-MODELCAT-SERVICE-TIER-COST-FU2：子代理本地开销口径按响应实报档位折价。
// ----------------------------------------------------------------------------
// pipeline 自己的 per-subagent 账（calculateTotalCost → estimateCost）此前不带
// serviceTier：flex 子代理按标准价计入 completeContext 审计总额、checkBudget
// 停/警阈值和 getRemainingBudget 递给嵌套子代理的余量——花费高估 2 倍，设了
// maxBudget 的无人值守 run 会在真实花费未到线时被提前拦停。
//
// 与 subagentPipeline.test.ts 不同：这里不 mock getBudgetService，用真实
// BudgetService + 真实价表。gpt-6.1-sol 刊例 input $2/M、output $10/M，flex
// 倍率 0.5 只折 input/output（SERVICE_TIER_COST_MULTIPLIER）。
// 证据档位 hermetic-protocol：订阅模型无一上报 service_tier=flex，真机复现
// 不可能，只有离线价表可证。
// ============================================================================

import { beforeEach, describe, expect, it } from 'vitest';
import {
  getSubagentPipeline,
  resetSubagentPipeline,
  type SubagentPipeline,
} from '../../../src/host/agent/subagentPipeline';
import { getBudgetService, type TokenUsage } from '../../../src/host/services/core/budgetService';
import { MODEL_PRICING_PER_1M, SERVICE_TIER_COST_MULTIPLIER } from '../../../src/shared/constants';
import type { DynamicAgentConfig } from '../../../src/host/agent/agentDefinition';

// 3M in + 1M out：标准 $16（$6+$10）、flex $8。价从价表取（不在测试里另抄一份
// 刊例）；整数 token 数配 $2/$10 单价，浮点结果逐位精确，断言可用 toBe。
const IN_TOKENS = 3_000_000;
const OUT_TOKENS = 1_000_000;
const GPT_SOL = MODEL_PRICING_PER_1M['gpt-6.1-sol'];
const STANDARD_COST = (IN_TOKENS / 1_000_000) * GPT_SOL.input + (OUT_TOKENS / 1_000_000) * GPT_SOL.output;
const FLEX_COST = STANDARD_COST * SERVICE_TIER_COST_MULTIPLIER.flex;

function flexUsage(): TokenUsage {
  return { inputTokens: IN_TOKENS, outputTokens: OUT_TOKENS, model: 'gpt-6.1-sol', provider: 'openai', timestamp: 1, serviceTier: 'flex' };
}

function usageWithTier(serviceTier?: string): TokenUsage {
  return { inputTokens: IN_TOKENS, outputTokens: OUT_TOKENS, model: 'gpt-6.1-sol', provider: 'openai', timestamp: 1, ...(serviceTier === undefined ? {} : { serviceTier }) };
}

function makeConfig(maxBudget?: number) {
  const config: DynamicAgentConfig = {
    name: 'Tier Agent',
    prompt: 'test',
    tools: ['read_file'],
    permissionPreset: 'development',
    ...(maxBudget === undefined ? {} : { maxBudget }),
  };
  return config;
}

describe('SubagentPipeline tier-aware local cost (N-MODELCAT-SERVICE-TIER-COST-FU2)', () => {
  let pipeline: SubagentPipeline;

  beforeEach(() => {
    resetSubagentPipeline();
    pipeline = getSubagentPipeline();
    // 全局 budget 单例是共享态：清历史并钉回「无上限」，保证 checkBudget 的
    // 全局半边恒 NONE，红绿只取决于子代理本地账。
    const global = getBudgetService('foreground');
    global.manualReset();
    global.updateConfig({ enabled: true, maxBudget: 0 });
  });

  it('subagentCost prices flex usage at exactly 0.5x of the same tier-less usage', () => {
    const flexCtx = pipeline.createContext(makeConfig(), '/test/project');
    for (let i = 0; i < 3; i++) flexCtx.tokenUsage.push(flexUsage());
    // getBudgetStatus 无条件带 subagentCost（calculateTotalCost 恒返回 number），`?` 是给别的调用点的
    const flexTotal = pipeline.getBudgetStatus(flexCtx).subagentCost!;

    const standardCtx = pipeline.createContext(makeConfig(), '/test/project');
    for (let i = 0; i < 3; i++) standardCtx.tokenUsage.push(usageWithTier());
    const standardTotal = pipeline.getBudgetStatus(standardCtx).subagentCost!;

    expect(flexTotal).toBe(24);
    expect(standardTotal).toBe(48);
    expect(flexTotal).toBe(standardTotal * 0.5);
  });

  it('standard / absent / unknown tier usages keep the pre-change figure bit for bit', () => {
    // 改动前的算法就是 input+output 刊例和：这里按同一算式内联复算，作为逐位对照。
    const preChange = (IN_TOKENS / 1_000_000) * GPT_SOL.input + (OUT_TOKENS / 1_000_000) * GPT_SOL.output;
    for (const tier of ['standard', undefined, 'priority']) {
      const ctx = pipeline.createContext(makeConfig(), '/test/project');
      ctx.tokenUsage.push(usageWithTier(tier));
      const cost = pipeline.getBudgetStatus(ctx).subagentCost!;
      expect(cost).toBe(preChange);
      expect(cost).toBe(STANDARD_COST);
    }
  });

  it('getRemainingBudget hands nested subagents the flex-discounted remainder', () => {
    const maxBudget = 50;
    const flexCtx = pipeline.createContext(makeConfig(maxBudget), '/test/project');
    flexCtx.tokenUsage.push(flexUsage());
    const flexRemaining = pipeline.getRemainingBudget(flexCtx)!;

    const standardCtx = pipeline.createContext(makeConfig(maxBudget), '/test/project');
    standardCtx.tokenUsage.push(usageWithTier());
    const standardRemaining = pipeline.getRemainingBudget(standardCtx)!;

    expect(flexRemaining).toBe(42);
    expect(standardRemaining).toBe(34);
    // flex 多出的余量恰为省下的那 $8
    expect(flexRemaining - standardRemaining).toBe(STANDARD_COST - FLEX_COST);
    expect(flexRemaining - standardRemaining).toBe(8);

    const mixedCtx = pipeline.createContext(makeConfig(maxBudget), '/test/project');
    mixedCtx.tokenUsage.push(flexUsage(), usageWithTier());
    expect(pipeline.getRemainingBudget(mixedCtx)).toBe(26);
  });

  it('checkBudget no longer stops a flex subagent whose standard price would exceed maxBudget, but still stops real overruns', () => {
    const maxBudget = 10;
    // 同样一笔 usage：标准价 $16 ≥ $10（改前口径会拦停），flex 实花 $8 < $10。
    const standardCtx = pipeline.createContext(makeConfig(maxBudget), '/test/project');
    standardCtx.tokenUsage.push(usageWithTier());
    expect(pipeline.checkBudget(standardCtx).allowed).toBe(false);

    const flexCtx = pipeline.createContext(makeConfig(maxBudget), '/test/project');
    flexCtx.tokenUsage.push(flexUsage());
    const underBudget = pipeline.checkBudget(flexCtx);
    expect(underBudget.allowed).toBe(true);
    expect(underBudget.warnings).toEqual([]);

    // 真花超线仍拦：再记一笔 flex（共 $16 ≥ $10）。
    flexCtx.tokenUsage.push(flexUsage());
    const overBudget = pipeline.checkBudget(flexCtx);
    expect(overBudget.allowed).toBe(false);
    expect(overBudget.reason).toBe('Subagent budget exceeded: $16.00 / $10.00');
  });

  it('completeContext, checkBudget and getBudgetStatus report the same tier-aware figure', () => {
    // 2 笔 flex = $16，恰好顶到 maxBudget=16：三条路径必须都报同一个 16。
    const ctx = pipeline.createContext(makeConfig(16), '/test/project');
    ctx.tokenUsage.push(flexUsage(), flexUsage());

    expect(pipeline.getBudgetStatus(ctx).subagentCost!).toBe(16);

    const check = pipeline.checkBudget(ctx);
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe('Subagent budget exceeded: $16.00 / $16.00');

    pipeline.completeContext(ctx.agentId, true);
    const completeEntry = pipeline.getAuditLog(ctx.agentId).find((e) => e.action === 'complete');
    expect(completeEntry?.cost).toBe(16);
  });
});
