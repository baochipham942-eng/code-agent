import { describe, expect, it } from 'vitest';
import {
  BudgetService,
  BudgetAlertLevel,
  type BudgetStatus,
} from '../../../../src/main/services/core/budgetService';

function usage(inputTokens: number, outputTokens: number) {
  return { inputTokens, outputTokens, model: 'default', provider: 'test', timestamp: 1 };
}

describe('BudgetService alert emission (Item4②)', () => {
  it('emits blocked once per period and re-arms after reset', () => {
    const svc = new BudgetService({
      enabled: true,
      maxBudget: 0.00001, // 极小预算 → 任意 usage 即超限
      silentThreshold: 0.7,
      warningThreshold: 0.85,
      blockThreshold: 1.0,
      resetPeriodHours: 24,
    });
    const calls: BudgetStatus[] = [];
    svc.setAlertListener((s) => calls.push(s));

    svc.recordUsage(usage(100_000, 100_000));
    expect(calls).toHaveLength(1);
    expect(calls[0].alertLevel).toBe(BudgetAlertLevel.BLOCKED);

    // 仍 blocked → 本周期不再重复推送
    svc.recordUsage(usage(100_000, 100_000));
    expect(calls).toHaveLength(1);

    // 周期重置后重新武装
    svc.resetPeriod();
    svc.recordUsage(usage(100_000, 100_000));
    expect(calls).toHaveLength(2);
  });

  it('emits a warning before reaching blocked', () => {
    const svc = new BudgetService({
      enabled: true,
      maxBudget: 1_000_000, // 先设大，首次 usage 占比极低不触发
      silentThreshold: 0.7,
      warningThreshold: 0.85,
      blockThreshold: 1.0,
      resetPeriodHours: 24,
    });
    const calls: BudgetStatus[] = [];
    svc.setAlertListener((s) => calls.push(s));

    svc.recordUsage(usage(10_000, 10_000));
    expect(calls).toHaveLength(0); // 占比极低，无告警

    // 把上限收到当前成本的 ~90% → 进入 warning 区间（85%-100%）
    const cost = svc.getCurrentCost();
    svc.updateConfig({ maxBudget: cost / 0.9 });
    // 0 成本的记账触发一次告警评估
    svc.recordUsage(usage(0, 0));

    expect(calls).toHaveLength(1);
    expect(calls[0].alertLevel).toBe(BudgetAlertLevel.WARNING);
  });

  it('does not emit when budget is disabled', () => {
    const svc = new BudgetService({ enabled: false, maxBudget: 0.00001 });
    const calls: BudgetStatus[] = [];
    svc.setAlertListener((s) => calls.push(s));
    svc.recordUsage(usage(100_000, 100_000));
    expect(calls).toHaveLength(0);
  });
});
