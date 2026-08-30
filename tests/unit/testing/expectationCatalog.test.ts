import { describe, expect, it } from 'vitest';
import { EXPECTATION_TYPE_CATALOG } from '../../../src/host/testing/expectationCatalog';

describe('EXPECTATION_TYPE_CATALOG', () => {
  it('T7：运行时目录没有重复项且每项都有摘要', () => {
    const keys = EXPECTATION_TYPE_CATALOG.map((item) => item.type);
    expect(new Set(keys).size).toBe(keys.length);
    expect(EXPECTATION_TYPE_CATALOG.every((item) => item.summary.length > 0)).toBe(true);
  });
});
