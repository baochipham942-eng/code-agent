import { beforeEach, describe, expect, it, vi } from 'vitest';

const appendUsageRecord = vi.fn();
vi.mock('../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ appendUsageRecord }),
}));

import {
  BudgetAlertLevel,
  getBudgetService,
  initBudgetService,
} from '../../../../src/host/services/core/budgetService';

// unknown-model / unknown-provider 落 MODEL_PRICING_PER_1M['default']（$1 in / $3 out per 1M）：
// 1M in + 1M out = $4。上限 $6：单笔 $4 = 67% 不越线，两笔合计 $8 = 133% 越线——
// 单笔各自安全、合计必拦，正好钉住「同 scope 并发 run 共用一个池」的口径。
const usage = (sessionId: string, tokens = 1_000_000) => ({
  inputTokens: tokens,
  outputTokens: tokens,
  model: 'unknown-model',
  provider: 'unknown-provider',
  timestamp: Date.now(),
  sessionId,
});

describe('concurrent runs in one scope share one budget pool', () => {
  beforeEach(() => {
    initBudgetService({
      foreground: { enabled: true, maxBudget: 6 },
      unattended: { enabled: true, maxBudget: 6 },
    });
    getBudgetService('foreground').manualReset();
    getBudgetService('unattended').manualReset();
    appendUsageRecord.mockClear();
  });

  it('blocks the later run once two same-scope runs cross the limit together', () => {
    const unattended = getBudgetService('unattended');

    unattended.recordUsage(usage('run-1'));
    expect(unattended.checkBudget().alertLevel).not.toBe(BudgetAlertLevel.BLOCKED);

    unattended.recordUsage(usage('run-2'));

    // 两个 run（不同 sessionId）落进同一个 usageHistory，checkBudget 按合计判。
    expect(unattended.getUsageHistory().map((entry) => entry.sessionId)).toEqual(['run-1', 'run-2']);
    expect(unattended.checkBudget().alertLevel).toBe(BudgetAlertLevel.BLOCKED);
    expect(unattended.shouldBlock()).toBe(true);
    expect(unattended.getCurrentCost()).toBeCloseTo(8);
  });

  it('keeps foreground and unattended pools separate for concurrent runs', () => {
    const foreground = getBudgetService('foreground');
    const unattended = getBudgetService('unattended');

    unattended.recordUsage(usage('run-1'));
    foreground.recordUsage(usage('run-2'));

    // 各自 $4/6 = 67%；若跨 scope 合并会双双 $8/6 = BLOCKED——都保持 NONE 即证明没有互相渗透。
    expect(unattended.checkBudget().alertLevel).toBe(BudgetAlertLevel.NONE);
    expect(foreground.checkBudget().alertLevel).toBe(BudgetAlertLevel.NONE);
    expect(unattended.shouldBlock()).toBe(false);
    expect(foreground.shouldBlock()).toBe(false);
    expect(unattended.getCurrentCost()).toBeCloseTo(4);
    expect(foreground.getCurrentCost()).toBeCloseTo(4);
  });

  it('pools interleaved runs regardless of recordUsage order', () => {
    const unattended = getBudgetService('unattended');

    // A,B,A,B：每笔 $2（0.5M in + 0.5M out），单 run 两笔共 $4 不越线，两 run 合计 $8 越线。
    unattended.recordUsage(usage('run-1', 500_000));
    unattended.recordUsage(usage('run-2', 500_000));
    expect(unattended.checkBudget().alertLevel).not.toBe(BudgetAlertLevel.BLOCKED);

    unattended.recordUsage(usage('run-1', 500_000));
    unattended.recordUsage(usage('run-2', 500_000));

    expect(unattended.getUsageHistory().map((entry) => entry.sessionId)).toEqual([
      'run-1',
      'run-2',
      'run-1',
      'run-2',
    ]);
    expect(unattended.checkBudget().alertLevel).toBe(BudgetAlertLevel.BLOCKED);
    expect(unattended.shouldBlock()).toBe(true);
    expect(unattended.getCurrentCost()).toBeCloseTo(8);
  });
});
