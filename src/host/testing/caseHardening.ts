import type { TestCase } from './types';

type CaseHardeningInput = Pick<TestCase, 'expect' | 'expectations' | 'reviewStatus' | 'answerSide'>;

export function expectationExists(testCase: CaseHardeningInput): boolean {
  return Object.keys(testCase.expect ?? {}).length > 0 || (testCase.expectations?.length ?? 0) > 0;
}

export function isCaseHardened(testCase: CaseHardeningInput): {
  hardened: boolean;
  reason?: 'no_expectations' | 'review_pending' | 'answer_side_missing';
} {
  if (testCase.answerSide === 'missing') return { hardened: false, reason: 'answer_side_missing' };
  if (!expectationExists(testCase)) return { hardened: false, reason: 'no_expectations' };
  if (testCase.reviewStatus === 'pending') return { hardened: false, reason: 'review_pending' };
  return { hardened: true };
}
