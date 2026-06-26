import { describe, expect, it } from 'vitest';
import { PlaywrightLaunchSemaphore } from '../../../../src/host/services/infra/playwrightLaunchSemaphore';

describe('PlaywrightLaunchSemaphore', () => {
  it('grants slots immediately while under max concurrent', async () => {
    const sem = new PlaywrightLaunchSemaphore(2);
    const a = await sem.acquire();
    const b = await sem.acquire();
    expect(sem.getActiveCount()).toBe(2);
    expect(sem.getQueueLength()).toBe(0);
    a.release();
    b.release();
    expect(sem.getActiveCount()).toBe(0);
  });

  it('queues additional acquires when max is reached and resolves them on release', async () => {
    const sem = new PlaywrightLaunchSemaphore(1);
    const first = await sem.acquire();

    let secondResolved = false;
    const secondPromise = sem.acquire().then((slot) => {
      secondResolved = true;
      return slot;
    });

    await Promise.resolve();
    expect(secondResolved).toBe(false);
    expect(sem.getActiveCount()).toBe(1);
    expect(sem.getQueueLength()).toBe(1);

    first.release();
    const second = await secondPromise;
    expect(secondResolved).toBe(true);
    expect(sem.getActiveCount()).toBe(1);
    second.release();
  });

  it('serves queued acquirers in FIFO order', async () => {
    const sem = new PlaywrightLaunchSemaphore(1);
    const blocking = await sem.acquire();
    const order: string[] = [];

    const a = sem.acquire().then((slot) => {
      order.push('a');
      return slot;
    });
    const b = sem.acquire().then((slot) => {
      order.push('b');
      return slot;
    });
    const c = sem.acquire().then((slot) => {
      order.push('c');
      return slot;
    });

    await Promise.resolve();
    expect(sem.getQueueLength()).toBe(3);

    blocking.release();
    const slotA = await a;
    slotA.release();
    const slotB = await b;
    slotB.release();
    const slotC = await c;
    slotC.release();

    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('is idempotent — releasing the same slot twice does not double-decrement', async () => {
    const sem = new PlaywrightLaunchSemaphore(2);
    const slot = await sem.acquire();
    expect(sem.getActiveCount()).toBe(1);
    slot.release();
    slot.release();
    slot.release();
    expect(sem.getActiveCount()).toBe(0);
  });

  it('clamps maxConcurrent to at least 1', async () => {
    const sem = new PlaywrightLaunchSemaphore(0);
    const slot = await sem.acquire();
    expect(sem.getActiveCount()).toBe(1);

    let secondResolved = false;
    const second = sem.acquire().then((s) => {
      secondResolved = true;
      return s;
    });
    await Promise.resolve();
    expect(secondResolved).toBe(false);

    slot.release();
    (await second).release();
  });
});
