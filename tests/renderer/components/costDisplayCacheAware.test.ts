import { describe, expect, it } from 'vitest';
import {
  resolveDisplayCost,
  buildCostTitle,
} from '../../../src/renderer/components/StatusBar/CostDisplay';
import type { BudgetStatusView } from '../../../src/renderer/hooks/useBudgetStatus';
import { zh } from '../../../src/renderer/i18n/zh';

// WP2-2a：CostDisplay cache-aware 口径的纯函数单测

function budget(overrides: Partial<BudgetStatusView> = {}): BudgetStatusView {
  return {
    enabled: true,
    currentCost: 0.5,
    maxBudget: 10,
    usagePercentage: 0.05,
    alertLevel: 'none',
    ...overrides,
  };
}

describe('resolveDisplayCost', () => {
  it('takes the larger of host-side real cost and renderer accumulation', () => {
    expect(resolveDisplayCost(0, budget({ currentCost: 0.5 }))).toBe(0.5);
    expect(resolveDisplayCost(0.8, budget({ currentCost: 0.5 }))).toBe(0.8);
  });

  it('falls back to renderer cost when budget status is unavailable', () => {
    expect(resolveDisplayCost(0.3, null)).toBe(0.3);
    expect(resolveDisplayCost(0.3, undefined)).toBe(0.3);
  });
});

describe('buildCostTitle', () => {
  it('budget enabled → usage title with cost/max/percent', () => {
    const title = buildCostTitle(zh.statusBar, 0.5, budget());
    expect(title).toContain('$0.50');
    expect(title).toContain('$10.00');
    expect(title).toContain('5%');
  });

  it('budget disabled → plain session cost title', () => {
    const title = buildCostTitle(zh.statusBar, 0.1234, null);
    expect(title).toContain('$0.1234');
  });

  it('appends cache-saved line when net savings >= $0.005', () => {
    const title = buildCostTitle(
      zh.statusBar,
      0.5,
      budget({ cacheSavings: { cacheReadTokens: 9000, cacheCreationTokens: 0, netSavedUsd: 0.42 } }),
    );
    expect(title).toContain('$0.42');
    expect(title.split('\n')).toHaveLength(2);
  });

  it('omits cache-saved line for negligible savings', () => {
    const title = buildCostTitle(
      zh.statusBar,
      0.5,
      budget({ cacheSavings: { cacheReadTokens: 10, cacheCreationTokens: 0, netSavedUsd: 0.001 } }),
    );
    expect(title.split('\n')).toHaveLength(1);
  });
});
