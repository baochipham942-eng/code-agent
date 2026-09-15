import { afterEach, describe, expect, it } from 'vitest';
import type { AgentInterface } from '../../../src/host/testing/testRunner';
import { TestRunner } from '../../../src/host/testing/testRunner';
import type { TestCase } from '../../../src/host/testing/types';
import { getBudgetService, initBudgetService } from '../../../src/host/services/core/budgetService';

// N-EVAL-REPORT-COST-MISMATCH：报告「成本与用量」逐 case 汇总 与 终端 Actual usage（进程 budget 账）
// 必须能对账。复现 K3 safety cde602da：cost_exceeded case 的越线调用只进了 case 账、没进进程账。
const CASE: TestCase = {
  id: 'cost-reconcile',
  type: 'conversation',
  description: 'cost reconcile',
  prompt: 'first',
  follow_up_prompts: ['second'],
  expect: {},
  max_cost_usd: 0.1,
};

afterEach(() => {
  initBudgetService();
});

describe('报告成本汇总与终端 Actual usage 对账', () => {
  it('越线调用同时进 case 账与进程账：prompt 含 cache、completion、USD 三数相等', async () => {
    initBudgetService({ enabled: true });
    // custom 渠道未收录 → default 价 $1/$3，cacheRead 0.1x（同 cde602da）
    const calls = [
      { inputTokens: 60_000, cacheReadTokens: 40_000, outputTokens: 2_000 },
      { inputTokens: 50_000, cacheReadTokens: 30_000, outputTokens: 1_000 },
    ];
    let i = 0;
    const agent: AgentInterface = {
      async sendMessage() {
        getBudgetService().recordUsage({
          ...calls[i++],
          model: 'deepseek-v4-flash',
          provider: 'custom-tokenrhythm',
          timestamp: Date.now(),
          source: 'provider',
        });
        return { responses: ['ok'], toolExecutions: [], turnCount: 1, errors: [] };
      },
      async reset() {},
      getAgentInfo: () => ({ name: 'cost-test', model: 'deepseek-v4-flash', provider: 'custom-tokenrhythm' }),
    };
    const runner = new TestRunner({
      testCaseDir: process.cwd(),
      resultsDir: process.cwd(),
      workingDirectory: process.cwd(),
      defaultTimeout: 1_000,
      parallel: false,
      maxParallel: 1,
      stopOnFailure: false,
      verbose: false,
    }, agent);

    const result = await runner.runSingleTest(CASE);

    expect(result.status).toBe('cost_exceeded');
    expect(result.usage).toMatchObject({ promptTokens: 180_000, completionTokens: 3_000, cacheReadTokens: 70_000 });

    // eval-ci.ts Actual usage 行的同一口径
    const history = getBudgetService().getUsageHistory();
    const processPrompt = history.reduce((s, u) => s + u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheCreationTokens ?? 0), 0);
    const processOut = history.reduce((s, u) => s + u.outputTokens, 0);
    expect(processPrompt).toBe(result.usage!.promptTokens);
    expect(processOut).toBe(result.usage!.completionTokens);
    expect(getBudgetService().getCurrentCost()).toBeCloseTo(result.costUsd!, 12);
  });
});
