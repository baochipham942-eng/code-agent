import { describe, expect, it } from 'vitest';

import { createKeyedSerializer } from '../../../../src/host/runtime/keyedSerializer';

describe('createKeyedSerializer', () => {
  it('runs same-key work in order', async () => {
    const serialize = createKeyedSerializer();
    const seen: number[] = [];
    await Promise.all([
      serialize('a', async () => {
        await Promise.resolve();
        seen.push(1);
      }),
      serialize('a', async () => {
        seen.push(2);
      }),
    ]);
    expect(seen).toEqual([1, 2]);
  });

  it('lets nested serialize on the same key run immediately', async () => {
    const serialize = createKeyedSerializer();
    const seen: string[] = [];
    await serialize('a', async () => {
      seen.push('outer');
      await serialize('a', async () => {
        seen.push('inner');
      });
      seen.push('after');
    });
    expect(seen).toEqual(['outer', 'inner', 'after']);
  });
});
