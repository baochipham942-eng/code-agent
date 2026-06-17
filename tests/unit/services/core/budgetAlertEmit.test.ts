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

  it('re-arms alert flags after updateConfig so a raised threshold can warn again (audit F2)', () => {
    const svc = new BudgetService({
      enabled: true,
      maxBudget: 1_000_000,
      silentThreshold: 0.7,
      warningThreshold: 0.85,
      blockThreshold: 1.0,
      resetPeriodHours: 24,
    });
    const calls: BudgetStatus[] = [];
    svc.setAlertListener((s) => calls.push(s));

    svc.recordUsage(usage(10_000, 10_000));
    const cost = svc.getCurrentCost();
    // 定位到 90% → warning
    svc.updateConfig({ maxBudget: cost / 0.9 });
    svc.recordUsage(usage(0, 0));
    expect(calls).toHaveLength(1);
    expect(calls[0].alertLevel).toBe(BudgetAlertLevel.WARNING);

    // 同周期再记账仍 90% → 去重，不重复
    svc.recordUsage(usage(0, 0));
    expect(calls).toHaveLength(1);

    // 改配置（升 maxBudget 让占比降到 ~80% 后再调回 95% 边界）→ updateConfig 重新武装
    svc.updateConfig({ warningThreshold: 0.95 });
    svc.recordUsage(usage(0, 0)); // 90% < 95% → 不再是 warning
    expect(calls).toHaveLength(1);

    // 收紧上限到 97% 越过新阈值 → 重新告警
    svc.updateConfig({ maxBudget: cost / 0.97 });
    svc.recordUsage(usage(0, 0));
    expect(calls).toHaveLength(2);
    expect(calls[1].alertLevel).toBe(BudgetAlertLevel.WARNING);
  });

  it('does NOT re-arm on no-op / unchanged config reload — no duplicate alert spam (audit R2 regression)', () => {
    const svc = new BudgetService({
      enabled: true,
      maxBudget: 1_000_000,
      silentThreshold: 0.7,
      warningThreshold: 0.85,
      blockThreshold: 1.0,
      resetPeriodHours: 24,
    });
    const calls: BudgetStatus[] = [];
    svc.setAlertListener((s) => calls.push(s));

    svc.recordUsage(usage(10_000, 10_000));
    const cost = svc.getCurrentCost();
    svc.updateConfig({ maxBudget: cost / 0.9 }); // 边界变化 → re-arm
    svc.recordUsage(usage(0, 0));
    expect(calls).toHaveLength(1); // warning 首发

    // benign 重载：相同 maxBudget 值 → 无边界变化 → 不 re-arm
    svc.updateConfig({ maxBudget: cost / 0.9 });
    svc.recordUsage(usage(0, 0));
    expect(calls).toHaveLength(1); // 不重复

    // 空 / no-op payload → 不 re-arm
    svc.updateConfig({});
    svc.recordUsage(usage(0, 0));
    expect(calls).toHaveLength(1); // 仍不重复
  });

  it('marks warning consumed when usage jumps straight to blocked (audit F1)', () => {
    const svc = new BudgetService({
      enabled: true,
      maxBudget: 0.00001,
      silentThreshold: 0.7,
      warningThreshold: 0.85,
      blockThreshold: 1.0,
      resetPeriodHours: 24,
    });
    const calls: BudgetStatus[] = [];
    svc.setAlertListener((s) => calls.push(s));

    // 一跃到 blocked（跨过 warning）
    svc.recordUsage(usage(100_000, 100_000));
    expect(calls).toHaveLength(1);
    expect(calls[0].alertLevel).toBe(BudgetAlertLevel.BLOCKED);
    // warning 视作已消费：本周期不再补发任何告警
    svc.recordUsage(usage(100_000, 100_000));
    expect(calls).toHaveLength(1);
  });

  it('does not emit when budget is disabled', () => {
    const svc = new BudgetService({ enabled: false, maxBudget: 0.00001 });
    const calls: BudgetStatus[] = [];
    svc.setAlertListener((s) => calls.push(s));
    svc.recordUsage(usage(100_000, 100_000));
    expect(calls).toHaveLength(0);
  });
});
