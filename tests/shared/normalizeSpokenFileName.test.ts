import { describe, expect, it } from 'vitest';
import { normalizeSpokenFileName } from '../../src/shared/utils/normalizeSpokenFileName';

describe('normalizeSpokenFileName', () => {
  it.each([
    ['八一六点md', '816.md'],
    ['一点.md', '1.md'],
    ['壹二点txt', '12.txt'],
    ['创建壹二点md', '创建12.md'],
  ])('normalizes digit-named files: %s', (input, expected) => {
    expect(normalizeSpokenFileName(input)).toBe(expected);
  });

  it.each(['三点半开会', '下午两点'])('leaves ordinary speech unchanged: %s', (input) => {
    expect(normalizeSpokenFileName(input)).toBe(input);
  });
});
