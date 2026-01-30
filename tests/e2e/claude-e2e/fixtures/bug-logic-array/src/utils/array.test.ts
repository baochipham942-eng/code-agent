import { describe, it, expect } from 'vitest';
import { unique, flatten } from './array.js';

describe('unique', () => {
  it('should work for primitive arrays', () => {
    expect(unique([1, 2, 2, 3])).toEqual([1, 2, 3]);
  });

  it('should work for object arrays with key', () => {
    const input = [{ id: 1 }, { id: 1 }, { id: 2 }];
    const result = unique(input, 'id');
    expect(result).toHaveLength(2);
    expect(result.map((x) => x.id)).toEqual([1, 2]);
  });

  it('should preserve first occurrence when deduping by key', () => {
    const input = [
      { id: 1, name: 'first' },
      { id: 1, name: 'second' },
    ];
    const result = unique(input, 'id');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('first');
  });
});

describe('flatten', () => {
  it('should flatten nested arrays', () => {
    expect(
      flatten([
        [1, 2],
        [3, 4],
      ])
    ).toEqual([1, 2, 3, 4]);
  });
});
