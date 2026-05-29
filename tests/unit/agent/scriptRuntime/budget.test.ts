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

describe('BudgetTracker reservation (并发硬上限)', () => {
  it('cold start: first reserve() reserves 0 so the first call is never pre-blocked', () => {
    const b = new BudgetTracker(20);
    expect(b.reserve()).toBe(0);
    expect(b.exceeded()).toBe(false);
  });

  it('reserve() uses the running average of committed calls', () => {
    const b = new BudgetTracker(1000);
    const e0 = b.reserve();        // 0 (no data)
    b.commit(e0, 100);            // 1 call, spent 100 → avg 100
    expect(b.reserve()).toBe(100); // next reservation = avg
  });

  it('exceeded() accounts for in-flight reservations (concurrent calls see each other)', () => {
    const b = new BudgetTracker(150);
    b.commit(b.reserve(), 100);   // spent 100, avg 100
    const e = b.reserve();        // reserve avg 100 → spent100 + reserved100 = 200 >= 150
    expect(e).toBe(100);
    expect(b.exceeded()).toBe(true);   // a concurrent call would now be blocked
    b.commit(e, 30);              // reservation released, actual 30 committed
    expect(b.spent()).toBe(130);
    expect(b.exceeded()).toBe(false);
  });

  it('remaining() reports the committed view (spent only, not reservations)', () => {
    const b = new BudgetTracker(200);
    b.commit(b.reserve(), 50);
    b.reserve(); // in-flight reservation must NOT shrink the reported remaining
    expect(b.remaining()).toBe(150);
  });

  // ── Codex R2 HIGH#1：原子 check+reserve（无 await 间隔），消除 gate 等待期 TOCTOU ──
  it('reserveOrThrow throws when exhausted and reserves atomically otherwise', () => {
    const b = new BudgetTracker(100);
    expect(b.reserveOrThrow()).toBe(0);   // cold start ok
    b.commit(0, 100);                     // spent 100 → exhausted
    expect(() => b.reserveOrThrow()).toThrow(/budget/i);
  });

  it('reserveOrThrow with no budget never throws', () => {
    const b = new BudgetTracker(null);
    expect(() => b.reserveOrThrow()).not.toThrow();
  });
});
