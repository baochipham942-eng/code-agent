// ============================================================================
// 默认预算不设隐形硬顶 —— 但记账半边必须照跑
// ============================================================================
// 背景：生产（webServer 路径）从不调 initBudgetService，getBudgetService() 懒构造
// 用的就是构造函数默认值。默认 maxBudget=$10 时，每个用户都在跑一条自己看不见也
// 改不了的 24h 硬顶，撞顶会中断主循环并报 BUDGET_EXCEEDED。
//
// 这道门钉两件事，缺一不可：
//   1. 未显式配置时永不 BLOCKED（没有隐形天花板）；
//   2. enabled 仍为 true —— 成本数字 / 缓存节省 / usage_ledger 全靠 recordUsage，
//      用「默认关掉 enabled」去掉硬顶会连带把记账一起停掉。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { BudgetService, BudgetAlertLevel } from '../../../src/host/services/core/budgetService';

const usage = (inputTokens: number) => ({
  inputTokens,
  outputTokens: inputTokens,
  model: 'deepseek-chat',
  provider: 'deepseek',
  timestamp: Date.now(),
});

describe('BudgetService 默认配置', () => {
  it('未显式配置时不设上限（maxBudget=0），记账仍开着', () => {
    const service = new BudgetService();
    const config = service.getConfig();
    expect(config.maxBudget).toBe(0);
    expect(config.enabled).toBe(true);
  });

  it('花再多也不 BLOCKED —— 默认档没有隐形天花板', () => {
    const service = new BudgetService();
    for (let i = 0; i < 50; i++) service.recordUsage(usage(20_000_000));

    const status = service.checkBudget();
    expect(status.alertLevel).toBe(BudgetAlertLevel.NONE);
    expect(status.usagePercentage).toBe(0);
    expect(service.wouldExceedBudget(1_000_000)).toBe(false);
  });

  it('记账半边照常累计（CostDisplay 的成本数字靠它）', () => {
    const service = new BudgetService();
    service.recordUsage(usage(1_000_000));
    expect(service.checkBudget().currentCost).toBeGreaterThan(0);
  });

  it('显式配了上限就照旧生效，该拦还是拦', () => {
    const service = new BudgetService({ maxBudget: 0.0001 });
    service.recordUsage(usage(1_000_000));
    expect(service.checkBudget().alertLevel).toBe(BudgetAlertLevel.BLOCKED);
  });
});
