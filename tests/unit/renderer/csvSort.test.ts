import { describe, expect, it } from 'vitest';
import { compareCsvCells } from '../../../src/renderer/utils/csvSort';

describe('compareCsvCells', () => {
  it('sorts numeric strings numerically, not lexicographically', () => {
    const values = ['10', '2', '1', '20'];
    const sorted = [...values].sort(compareCsvCells);
    expect(sorted).toEqual(['1', '2', '10', '20']);
  });

  it('falls back to locale compare when either side is non-numeric', () => {
    expect(compareCsvCells('apple', 'banana')).toBeLessThan(0);
    expect(compareCsvCells('banana', 'apple')).toBeGreaterThan(0);
    expect(compareCsvCells('1', 'a')).toBeLessThan(0);
  });

  it('does not treat empty strings as numeric zeros', () => {
    // Empty must go with string sort, otherwise '' would equal '0' numerically.
    expect(compareCsvCells('', '0')).not.toBe(0);
    const values = ['2', '', '1'];
    const sorted = [...values].sort(compareCsvCells);
    expect(sorted[0]).toBe('');
  });

  it('treats null/undefined as empty strings', () => {
    expect(compareCsvCells(null, 'a')).toBeLessThan(0);
    expect(compareCsvCells(undefined, null)).toBe(0);
  });

  it('handles negative numbers and decimals', () => {
    const values = ['-1', '1.5', '-2.3', '0'];
    const sorted = [...values].sort(compareCsvCells);
    expect(sorted).toEqual(['-2.3', '-1', '0', '1.5']);
  });
});
