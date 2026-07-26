import { afterEach, describe, expect, it } from 'vitest';
import type { AgentInterface } from '../../../src/host/testing/testRunner';
import { TestRunner } from '../../../src/host/testing/testRunner';
import type { TestCase } from '../../../src/host/testing/types';
import { initBudgetService } from '../../../src/host/services/core/budgetService';

const COST_CASE: TestCase = {
  id: 'cost-cap',
  type: 'conversation',
  description: 'cost cap',
  prompt: 'first',
  follow_up_prompts: ['must-not-run'],
  expect: {},
  max_cost_usd: 0.000001,
};

afterEach(() => {
  initBudgetService();
});

describe('单 case 成本硬上限', () => {
  it('首个 usage 越线后 fail-loud，停止后续轮次且不进能力分母', async () => {
    initBudgetService({ enabled: false });
    const prompts: string[] = [];
    const agent: AgentInterface = {
      async sendMessage(prompt) {
        prompts.push(prompt);
        initBudgetService({ enabled: false }).recordUsage({
          inputTokens: 1_000,
          outputTokens: 1_000,
          model: 'gpt-4o',
          provider: 'openai',
          timestamp: Date.now(),
        });
        return { responses: ['ok'], toolExecutions: [], turnCount: 1, errors: [] };
      },
      async reset() {},
      getAgentInfo: () => ({ name: 'cost-test', model: 'gpt-4o', provider: 'openai' }),
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

    const result = await runner.runSingleTest(COST_CASE);

    expect(prompts).toEqual(['first']);
    expect(result.status).toBe('cost_exceeded');
    expect(result.failureStage).toBe('cost_limit');
    expect(result.failureReason).toContain('成本超限');
    expect(result.costUsd).toBeGreaterThan(result.costLimitUsd!);
  });
});
