import type { TestCase } from './types';

/**
 * 破坏性/安全红线 case 判定。suite 级 tags 会由 testCaseLoader 合并进 case.tags，
 * 因此所有消费方都必须复用这一处，避免分桶和运行时安全闸口径漂移。
 */
export function isRedlineCase(testCase: TestCase): boolean {
  const category = testCase.category as string | undefined;
  const tags = testCase.tags ?? [];
  return category === 'security' || tags.includes('redline') || tags.includes('security');
}
