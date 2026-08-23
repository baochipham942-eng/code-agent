import { beforeEach, describe, expect, it, vi } from 'vitest';

const appendUsageRecord = vi.fn();
vi.mock('../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ appendUsageRecord }),
}));

import {
  BudgetAlertLevel,
  getBudgetService,
  initBudgetService,
  resolveBudgetScope,
} from '../../../../src/host/services/core/budgetService';

const usage = () => ({
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  model: 'unknown-model',
  provider: 'unknown-provider',
  timestamp: Date.now(),
});

describe('scoped budget pools', () => {
  beforeEach(() => {
    initBudgetService({
      foreground: { enabled: true, maxBudget: 1 },
      unattended: { enabled: true, maxBudget: 1 },
    });
    getBudgetService('foreground').manualReset();
    getBudgetService('unattended').manualReset();
    appendUsageRecord.mockClear();
  });

  it('isolates usage, blocking, estimates, and alerts in both directions', () => {
    const foreground = getBudgetService('foreground');
    const unattended = getBudgetService('unattended');
    const foregroundAlert = vi.fn();
    const unattendedAlert = vi.fn();
    foreground.setAlertListener(foregroundAlert);
    unattended.setAlertListener(unattendedAlert);

    unattended.recordUsage(usage());

    expect(unattended.checkBudget().alertLevel).toBe(BudgetAlertLevel.BLOCKED);
    expect(unattended.wouldExceedBudget(0.01)).toBe(true);
    expect(foreground.checkBudget().alertLevel).toBe(BudgetAlertLevel.NONE);
    expect(foreground.wouldExceedBudget(0.01)).toBe(false);
    expect(unattendedAlert).toHaveBeenCalledTimes(1);
    expect(foregroundAlert).not.toHaveBeenCalled();

    unattended.manualReset();
    foreground.recordUsage(usage());

    expect(foreground.checkBudget().alertLevel).toBe(BudgetAlertLevel.BLOCKED);
    expect(unattended.checkBudget().alertLevel).toBe(BudgetAlertLevel.NONE);
    expect(foregroundAlert).toHaveBeenCalledTimes(1);
  });

  it('keeps legacy defaults and omitted unattended limits non-blocking', () => {
    initBudgetService({ enabled: true, maxBudget: 0, resetPeriodHours: 24 });
    const foreground = getBudgetService('foreground');
    const unattended = getBudgetService('unattended');

    foreground.manualReset();
    unattended.manualReset();
    unattended.recordUsage(usage());

    expect(foreground.getConfig().maxBudget).toBe(0);
    expect(unattended.getConfig().maxBudget).toBe(0);
    expect(unattended.checkBudget().alertLevel).toBe(BudgetAlertLevel.NONE);
    expect(unattended.wouldExceedBudget(Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(getBudgetService()).toBe(foreground);
  });

  it('maps cron/heartbeat topology to unattended and fails safe to foreground', () => {
    // cron and heartbeat both call setExecutionTopology('async_agent') before sendMessage.
    expect(resolveBudgetScope('async_agent')).toBe('unattended');
    expect(resolveBudgetScope('main')).toBe('foreground');
    expect(resolveBudgetScope('teammate')).toBe('foreground');
    expect(resolveBudgetScope(undefined)).toBe('foreground');
    expect(resolveBudgetScope('unknown-future-topology')).toBe('foreground');
  });
});
