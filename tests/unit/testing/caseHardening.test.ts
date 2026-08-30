import { describe, expect, it } from 'vitest';
import { isCaseHardened } from '../../../src/host/testing/caseHardening';

describe('case hardening truth table', () => {
  it('T1：同时检查判定标准与人工确认状态', () => {
    expect(isCaseHardened({ expect: { response_contains: ['ok'] } })).toEqual({ hardened: true });
    expect(isCaseHardened({
      expect: {},
      expectations: [{ type: 'no_crash', description: 'does not crash', params: {} }],
    })).toEqual({ hardened: true });
    expect(isCaseHardened({ expect: {} })).toEqual({
      hardened: false,
      reason: 'no_expectations',
    });
    expect(isCaseHardened({
      expect: { response_contains: ['ok'] },
      reviewStatus: 'pending',
    })).toEqual({ hardened: false, reason: 'review_pending' });
    expect(isCaseHardened({ expect: {}, reviewStatus: 'reviewed' })).toEqual({
      hardened: false,
      reason: 'no_expectations',
    });
  });
});
