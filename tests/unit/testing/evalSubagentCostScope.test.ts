// ============================================================================
// N-EVAL-ORCHARM：子代理花费必须算进本题成本上限
// ============================================================================
// 看不见子代理花费的上限是假上限：实验臂一开扇出，真实开销全跑到 case 记账外面，
// max_cost_usd 就拦不住任何东西。
//
// 两条生产路径，同一个 case 记账上下文：
//   父 AgentLoop → BudgetService.recordUsage(usage, scopedCostRecorder)  （显式句柄）
//   子代理       → SubagentPipeline.recordTokenUsage → BudgetService.recordUsage(usage)
//                  （无句柄，落 AsyncLocalStorage 里的当前 case state）
// 这里用真实的 SubagentPipeline 与 BudgetService，只把 case 上下文换成
// testRunner 用的同一个 createScopedCostLimit。
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  createScopedCostLimit,
  isScopedCostLimitExceeded,
} from '../../../src/host/services/core/scopedCostLimit';
import {
  getBudgetService,
  type TokenUsage,
} from '../../../src/host/services/core/budgetService';
import {
  getSubagentPipeline,
  type SubagentExecutionContext,
} from '../../../src/host/agent/subagentPipeline';

const MODEL = { model: 'claude-sonnet-4-5', provider: 'anthropic' };

function usage(inputTokens: number, outputTokens: number): TokenUsage {
  return {
    inputTokens,
    outputTokens,
    ...MODEL,
    timestamp: Date.now(),
    sessionId: 'case-session',
    source: 'provider',
  };
}

/** SubagentPipeline.recordTokenUsage 只读 tokenUsage / budgetScope 两项；其余字段本用例不涉及。 */
function pipelineContext(): SubagentExecutionContext {
  return {
    agentId: 'child-1',
    agentName: 'coder',
    permissionConfig: {} as SubagentExecutionContext['permissionConfig'],
    workingDirectory: '/tmp',
    startTime: 0,
    toolsUsed: [],
    tokenUsage: [],
    budgetScope: 'foreground',
  };
}

function costOf(input: number, output: number): number {
  return getBudgetService().estimateCost(input, output, MODEL.model, MODEL.provider);
}

describe('子代理花费进本题 costUsd', () => {
  it('父 loop 花 X、子代理花 Y ⇒ case costUsd = X + Y', async () => {
    const parentCost = costOf(1_000, 1_000);
    const childCost = costOf(4_000, 4_000);
    expect(parentCost).toBeGreaterThan(0);
    expect(childCost).toBeGreaterThan(0);

    const tracker = createScopedCostLimit(Number.MAX_VALUE);
    await tracker.run(async () => {
      // 父：AgentLoop 显式带 scopedCostRecorder 句柄
      getBudgetService().recordUsage(usage(1_000, 1_000), tracker.recordUsage);
      // 子：subagentExecutor → pipeline.recordTokenUsage，无句柄，靠 ALS 归本 case
      getSubagentPipeline().recordTokenUsage(pipelineContext(), usage(4_000, 4_000));
    });

    expect(tracker.getCostUsd()).toBeCloseTo(parentCost + childCost, 10);
    // 子代理那笔真的进来了，而不是只记了父的
    expect(tracker.getCostUsd()).toBeGreaterThan(parentCost);
  });

  it('父花费不超限、加上子代理才越线 ⇒ 按既有 cost_exceeded 路径中止', async () => {
    const parentCost = costOf(1_000, 1_000);
    const childCost = costOf(20_000, 20_000);
    // 上限卡在「父够用、父+子不够用」之间，只有子代理花费真的进账才会触发。
    const limit = parentCost + childCost / 2;
    expect(limit).toBeGreaterThan(parentCost);

    const tracker = createScopedCostLimit(limit);
    let thrown: unknown;
    try {
      await tracker.run(async () => {
        getBudgetService().recordUsage(usage(1_000, 1_000), tracker.recordUsage);
        getSubagentPipeline().recordTokenUsage(pipelineContext(), usage(20_000, 20_000));
      });
    } catch (error) {
      thrown = error;
    }

    // testRunner 就是靠这个判定把 case 标成 cost_exceeded 的
    expect(isScopedCostLimitExceeded(thrown)).toBe(true);
    expect((thrown as Error).message).toContain('成本超限：单 case');
  });

  it('没有 case 记账上下文时子代理记账是零副作用（不污染别的题）', () => {
    const tracker = createScopedCostLimit(Number.MAX_VALUE);
    getSubagentPipeline().recordTokenUsage(pipelineContext(), usage(9_999, 9_999));
    expect(tracker.getCostUsd()).toBe(0);
  });
});
