import { describe, expect, it, vi, beforeEach } from 'vitest';

// budgetService.recordUsage() 记账后 best-effort 落 usage_ledger（A7）。
// mock 掉 databaseService，直接断言接线点：record 时机 + 字段口径，而不依赖真实 sqlite。
const appendUsageRecord = vi.fn();
vi.mock('../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ appendUsageRecord }),
}));

import { BudgetService } from '../../../../src/host/services/core/budgetService';

describe('BudgetService → usage_ledger 接线（A7）', () => {
  beforeEach(() => {
    appendUsageRecord.mockClear();
  });

  it('recordUsage 触发一次 appendUsageRecord，字段与归一化口径一致', () => {
    const svc = new BudgetService({ enabled: true, maxBudget: 1_000_000 });
    svc.recordUsage({
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheCreationTokens: 50,
      model: 'deepseek-chat',
      provider: 'deepseek',
      timestamp: 123456,
      sessionId: 'sess-1',
    });

    expect(appendUsageRecord).toHaveBeenCalledTimes(1);
    expect(appendUsageRecord).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      model: 'deepseek-chat',
      provider: 'deepseek',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheCreationTokens: 50,
      recordedAt: 123456,
    });
  });

  it('sessionId 缺省（如 max-mode overhead 记账）时仍落账，sessionId 为 undefined', () => {
    const svc = new BudgetService({ enabled: true, maxBudget: 1_000_000 });
    svc.recordUsage({
      inputTokens: 10, outputTokens: 5, model: 'kimi-k2.5', provider: 'moonshot', timestamp: 1,
    });

    expect(appendUsageRecord).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: undefined, model: 'kimi-k2.5', provider: 'moonshot', inputTokens: 10, outputTokens: 5,
    }));
  });

  it('budget 关闭时不记账、不落账本', () => {
    const svc = new BudgetService({ enabled: false, maxBudget: 1_000_000 });
    svc.recordUsage({ inputTokens: 10, outputTokens: 5, model: 'm', provider: 'p', timestamp: 1 });
    expect(appendUsageRecord).not.toHaveBeenCalled();
  });

  it('每次 recordUsage 都追加一条（非覆盖式，呼应"逐条落表"而非 last_token_usage 单列覆盖）', () => {
    const svc = new BudgetService({ enabled: true, maxBudget: 1_000_000 });
    svc.recordUsage({ inputTokens: 1, outputTokens: 1, model: 'm', provider: 'p', timestamp: 1 });
    svc.recordUsage({ inputTokens: 2, outputTokens: 2, model: 'm', provider: 'p', timestamp: 2 });
    svc.recordUsage({ inputTokens: 3, outputTokens: 3, model: 'm', provider: 'p', timestamp: 3 });
    expect(appendUsageRecord).toHaveBeenCalledTimes(3);
  });
});
