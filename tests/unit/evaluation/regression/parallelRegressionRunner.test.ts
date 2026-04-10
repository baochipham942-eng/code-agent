// ============================================================================
// parallelRegressionRunner tests — V3-γ Multi-Eval Parallelism
// ============================================================================

import { describe, it, expect } from 'vitest';
import { pLimit } from '../../../../src/main/evaluation/regression/parallelRegressionRunner';
import { filterCasesByCategory } from '../../../../src/main/evaluation/regression/regressionRunner';
import type { RegressionCase } from '../../../../src/main/evaluation/regression/regressionTypes';

function makeCase(id: string, categories?: string[]): RegressionCase {
  return {
    id,
    filePath: `/tmp/${id}.md`,
    source: 'test',
    tags: [],
    categories,
    relatedRules: [],
    evalCommand: 'echo ok',
    scenario: '',
    expectedBehavior: '',
  };
}

describe('pLimit (concurrency semaphore)', () => {
  it('limits concurrent tasks to the specified number', async () => {
    let active = 0;
    let maxActive = 0;

    const limit = pLimit(2);

    const task = () =>
      limit(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 50));
        active--;
        return 'done';
      });

    const results = await Promise.all([task(), task(), task(), task(), task()]);

    expect(maxActive).toBeLessThanOrEqual(2);
    expect(results).toEqual(['done', 'done', 'done', 'done', 'done']);
  });

  it('runs all tasks even when some reject', async () => {
    const limit = pLimit(2);
    let completed = 0;

    const good = () =>
      limit(async () => {
        completed++;
        return 'ok';
      });
    const bad = () =>
      limit(async () => {
        completed++;
        throw new Error('fail');
      });

    const results = await Promise.allSettled([good(), bad(), good(), bad(), good()]);
    expect(completed).toBe(5);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(2);
  });

  it('with concurrency=1 runs tasks serially', async () => {
    const order: number[] = [];
    const limit = pLimit(1);

    await Promise.all(
      [1, 2, 3].map((n) =>
        limit(async () => {
          order.push(n);
          await new Promise((r) => setTimeout(r, 10));
        }),
      ),
    );

    expect(order).toEqual([1, 2, 3]);
  });

  it('with high concurrency runs all tasks immediately', async () => {
    let active = 0;
    let maxActive = 0;
    const limit = pLimit(100);

    await Promise.all(
      Array.from({ length: 10 }, () =>
        limit(async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 20));
          active--;
        }),
      ),
    );

    expect(maxActive).toBe(10);
  });

  it('resolves with the correct return value', async () => {
    const limit = pLimit(2);
    const result = await limit(async () => 42);
    expect(result).toBe(42);
  });
});

describe('filterCasesByCategory', () => {
  it('returns all cases when no filter specified', () => {
    const cases = [makeCase('c1', ['loop']), makeCase('c2', ['tool'])];
    expect(filterCasesByCategory(cases)).toEqual(cases);
    expect(filterCasesByCategory(cases, [])).toEqual(cases);
    expect(filterCasesByCategory(cases, undefined)).toEqual(cases);
  });

  it('filters cases by category intersection', () => {
    const cases = [
      makeCase('c1', ['loop', 'bash']),
      makeCase('c2', ['tool', 'error']),
      makeCase('c3', ['loop', 'env']),
    ];
    const filtered = filterCasesByCategory(cases, ['loop']);
    expect(filtered.map((c) => c.id)).toEqual(['c1', 'c3']);
  });

  it('excludes cases with no categories when filter is provided', () => {
    const cases = [makeCase('c1'), makeCase('c2', ['loop'])];
    const filtered = filterCasesByCategory(cases, ['loop']);
    expect(filtered.map((c) => c.id)).toEqual(['c2']);
  });

  it('is case-insensitive', () => {
    const cases = [makeCase('c1', ['LOOP']), makeCase('c2', ['Tool'])];
    const filtered = filterCasesByCategory(cases, ['loop', 'tool']);
    expect(filtered).toHaveLength(2);
  });

  it('returns empty array when no cases match the filter', () => {
    const cases = [makeCase('c1', ['loop']), makeCase('c2', ['bash'])];
    expect(filterCasesByCategory(cases, ['nonexistent'])).toEqual([]);
  });
});
