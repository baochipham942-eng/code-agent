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

  it('queues a sibling that arrives while the holder is awaiting', async () => {
    const serialize = createKeyedSerializer();
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const startedGate = new Promise<void>((resolve) => {
      started = resolve;
    });

    const first = serialize('a', async () => {
      started();
      await gate;
      seen.push('first');
      await serialize('a', async () => {
        seen.push('nested');
      });
    });
    await startedGate;

    let siblingRan = false;
    const second = serialize('a', async () => {
      siblingRan = true;
      seen.push('second');
    });
    await Promise.resolve();
    expect(siblingRan).toBe(false);
    expect(seen).toEqual([]);

    release();
    await Promise.all([first, second]);
    expect(seen).toEqual(['first', 'nested', 'second']);
  });
});
