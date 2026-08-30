import { describe, expect, it } from 'vitest';
import { parseAiReviewList } from '../../scripts/lib/eval-ai-review-args';

describe('eval --ai-review args', () => {
  it('解析逗号列表、去重，并拒绝未知维度', () => {
    expect(parseAiReviewList('task_completed,confirmed_before_acting,task_completed'))
      .toEqual(['task_completed', 'confirmed_before_acting']);
    expect(() => parseAiReviewList('task_completed,unknown')).toThrow(/unknown/);
  });
});
