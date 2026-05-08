import { describe, expect, it } from 'vitest';
import { ComputerSurfaceMutex } from '../../../../src/main/services/desktop/computerSurfaceLock';

describe('ComputerSurfaceMutex', () => {
  it('grants the first acquire immediately and blocks subsequent ones', async () => {
    const lock = new ComputerSurfaceMutex();
    const first = await lock.acquire();
    expect(lock.isHeld()).toBe(true);

    let secondResolved = false;
    const secondPromise = lock.acquire().then((slot) => {
      secondResolved = true;
      return slot;
    });

    await Promise.resolve();
    expect(secondResolved).toBe(false);
    expect(lock.getQueueLength()).toBe(1);

    first.release();
    const second = await secondPromise;
    expect(secondResolved).toBe(true);
    expect(lock.isHeld()).toBe(true);
    second.release();
    expect(lock.isHeld()).toBe(false);
  });

  it('serves queued acquirers in FIFO order', async () => {
    const lock = new ComputerSurfaceMutex();
    const blocking = await lock.acquire();
    const order: string[] = [];

    const a = lock.acquire().then((s) => { order.push('a'); return s; });
    const b = lock.acquire().then((s) => { order.push('b'); return s; });
    const c = lock.acquire().then((s) => { order.push('c'); return s; });

    await Promise.resolve();
    expect(lock.getQueueLength()).toBe(3);

    blocking.release();
    (await a).release();
    (await b).release();
    (await c).release();

    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('release is idempotent — calling twice does not corrupt the held flag', async () => {
    const lock = new ComputerSurfaceMutex();
    const slot = await lock.acquire();
    expect(lock.isHeld()).toBe(true);
    slot.release();
    slot.release();
    slot.release();
    expect(lock.isHeld()).toBe(false);

    // Subsequent acquire still works.
    const next = await lock.acquire();
    expect(lock.isHeld()).toBe(true);
    next.release();
  });

  it('does not let an idempotent release accidentally hand off to a queued waiter', async () => {
    const lock = new ComputerSurfaceMutex();
    const first = await lock.acquire();
    const secondPromise = lock.acquire();

    first.release();
    const second = await secondPromise;
    expect(lock.isHeld()).toBe(true);

    // Re-releasing first must not flip held off while second is still using it.
    first.release();
    expect(lock.isHeld()).toBe(true);

    second.release();
    expect(lock.isHeld()).toBe(false);
  });
});
