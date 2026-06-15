import { describe, expect, it } from 'vitest';
import { diffLinesWithFastPath, hasCommonNonEmptyLine } from '../../../src/renderer/utils/fastDiff';

describe('fastDiff', () => {
  it('uses a whole-file replace diff when the texts share no non-empty lines', () => {
    const changes = diffLinesWithFastPath('old a\nold b', 'new a\nnew b');

    expect(hasCommonNonEmptyLine('old a\nold b', 'new a\nnew b')).toBe(false);
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({ removed: true, value: 'old a\nold b', count: 2 });
    expect(changes[1]).toMatchObject({ added: true, value: 'new a\nnew b', count: 2 });
  });

  it('falls back to normal diffing when a shared line can anchor the diff', () => {
    const changes = diffLinesWithFastPath('same\nold', 'same\nnew');

    expect(hasCommonNonEmptyLine('same\nold', 'same\nnew')).toBe(true);
    expect(changes.some((change) => !change.added && !change.removed && change.value.includes('same'))).toBe(true);
    expect(changes.some((change) => change.removed && change.value.includes('old'))).toBe(true);
    expect(changes.some((change) => change.added && change.value.includes('new'))).toBe(true);
  });

  it('keeps identical text as one unchanged block', () => {
    expect(diffLinesWithFastPath('same\ntext', 'same\ntext')).toEqual([
      { value: 'same\ntext', count: 2, added: false, removed: false },
    ]);
  });
});
