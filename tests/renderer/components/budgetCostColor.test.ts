import { describe, expect, it } from 'vitest';
import { budgetCostColorClass } from '../../../src/renderer/components/StatusBar/CostDisplay';

describe('budgetCostColorClass', () => {
  it('uses red at blocked (>=100%)', () => {
    expect(budgetCostColorClass('blocked')).toBe('text-red-400');
  });

  it('uses amber at warning (85-90%)', () => {
    expect(budgetCostColorClass('warning')).toBe('text-amber-400');
  });

  it('stays emerald for silent / none / undefined (budget healthy or disabled)', () => {
    expect(budgetCostColorClass('silent')).toBe('text-emerald-400');
    expect(budgetCostColorClass('none')).toBe('text-emerald-400');
    expect(budgetCostColorClass(undefined)).toBe('text-emerald-400');
  });
});
