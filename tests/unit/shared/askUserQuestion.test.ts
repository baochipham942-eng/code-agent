import { describe, expect, it } from 'vitest';

import { normalizeUserQuestionOption } from '../../../src/shared/contract/askUserQuestion';

describe('AskUserQuestion option contract', () => {
  it.each([
    ['方案 A (推荐)', '方案 A'],
    ['Plan B (Recommended)', 'Plan B'],
  ])('parses the recommended label suffix without leaking it into the answer label', (label, expected) => {
    expect(normalizeUserQuestionOption({ label, description: 'desc' })).toEqual({
      label: expected,
      description: 'desc',
      recommended: true,
    });
  });

  it('keeps structured recommended options and ordinary options intact', () => {
    expect(normalizeUserQuestionOption({ label: 'A', description: 'a', recommended: true })).toEqual({
      label: 'A',
      description: 'a',
      recommended: true,
    });
    expect(normalizeUserQuestionOption({ label: 'B', description: 'b' })).toEqual({
      label: 'B',
      description: 'b',
    });
  });
});
