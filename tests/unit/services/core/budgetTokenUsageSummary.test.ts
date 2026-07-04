import { describe, expect, it } from 'vitest';
import { BudgetService } from '../../../../src/host/services/core/budgetService';

function makeService() {
  return new BudgetService({ enabled: true, maxBudget: 100, resetPeriodHours: 24 });
}

describe('BudgetService.getTokenUsageSummary (WP-2 token 状态栏活值)', () => {
  it('sums input/output/cache tokens across the usage history', () => {
    const svc = makeService();
    svc.recordUsage({
      inputTokens: 1000,
      outputTokens: 200,
      model: 'glm-5',
      provider: 'zhipu',
      timestamp: 1,
    });
    svc.recordUsage({
      inputTokens: 500,
      outputTokens: 300,
      cacheReadTokens: 2000,
      cacheCreationTokens: 100,
      model: 'glm-5',
      provider: 'zhipu',
      timestamp: 2,
    });

    expect(svc.getTokenUsageSummary()).toEqual({
      inputTokens: 1500,
      outputTokens: 500,
      cacheReadTokens: 2000,
      cacheCreationTokens: 100,
    });
  });

  it('returns zeros with no usage recorded', () => {
    expect(makeService().getTokenUsageSummary()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });
});
