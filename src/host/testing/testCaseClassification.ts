import type { TestCase } from './types';

/**
 * 破坏性/安全红线 case 判定。suite 级 tags 单独保存在 inheritedTags，避免
 * 改变 case 级标签筛选口径；安全闸仍必须显式读取继承标签。
 */
export function isRedlineCase(testCase: TestCase): boolean {
  const category = testCase.category as string | undefined;
  const tags = [...(testCase.tags ?? []), ...(testCase.inheritedTags ?? [])];
  return category === 'security' || tags.includes('redline') || tags.includes('security');
}
