// ============================================================================
// BudgetTracker Tests (P2-B token budget)
//
// 按 outputTokens 累加（对齐 Claude Code Workflow 的 budget.spent() 语义）。total=null 时
// remaining()=Infinity、永不 exceeded（无预算 = 不设限）。total 给定时是硬上限。
// ============================================================================

import { describe, it, expect } from 'vitest';
import { BudgetTracker } from '../../../../src/main/agent/scriptRuntime/budget';

describe('BudgetTracker', () => {
  it('with no total: remaining is Infinity and never exceeded', () => {
    const b = new BudgetTracker(null);
    expect(b.total).toBeNull();
    expect(b.remaining()).toBe(Infinity);
    expect(b.exceeded()).toBe(false);
    b.add(10_000);
    expect(b.spent()).toBe(10_000);
    expect(b.remaining()).toBe(Infinity);
    expect(b.exceeded()).toBe(false);
  });

  it('with a total: tracks spent / remaining and flips exceeded at the ceiling', () => {
    const b = new BudgetTracker(100);
    b.add(60);
    expect(b.spent()).toBe(60);
    expect(b.remaining()).toBe(40);
    expect(b.exceeded()).toBe(false);
    b.add(60);
    expect(b.spent()).toBe(120);
    expect(b.remaining()).toBe(0); // clamped, never negative
    expect(b.exceeded()).toBe(true);
  });

  it('ignores non-positive token deltas', () => {
    const b = new BudgetTracker(100);
    b.add(0);
    b.add(-5);
    expect(b.spent()).toBe(0);
  });
});
