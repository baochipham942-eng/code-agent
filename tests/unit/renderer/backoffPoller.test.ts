import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackoffPoller } from '../../../src/renderer/utils/backoffPoller';

describe('createBackoffPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs immediately then polls at the base interval while healthy', async () => {
    const task = vi.fn(async () => {});
    const poller = createBackoffPoller(task, { baseInterval: 2000, maxInterval: 30000 });

    poller.start();
    expect(task).toHaveBeenCalledTimes(1); // immediate
    await vi.advanceTimersByTimeAsync(2000);
    expect(task).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(task).toHaveBeenCalledTimes(3);
    expect(poller.getCurrentInterval()).toBe(2000);
    poller.stop();
  });

  it('exponentially backs off on consecutive failures up to the cap', async () => {
    const task = vi.fn(async () => {
      throw new Error('backend down');
    });
    const poller = createBackoffPoller(task, {
      baseInterval: 2000,
      maxInterval: 16000,
      factor: 2,
    });

    poller.start();
    await Promise.resolve(); // let immediate run settle
    expect(poller.getCurrentInterval()).toBe(4000); // 2000*2 after 1st failure

    await vi.advanceTimersByTimeAsync(4000);
    expect(poller.getCurrentInterval()).toBe(8000);

    await vi.advanceTimersByTimeAsync(8000);
    expect(poller.getCurrentInterval()).toBe(16000);

    await vi.advanceTimersByTimeAsync(16000);
    expect(poller.getCurrentInterval()).toBe(16000); // capped
    poller.stop();
  });

  it('only fires onError once per failure streak (no log flood)', async () => {
    const onError = vi.fn();
    const task = vi.fn(async () => {
      throw new Error('down');
    });
    const poller = createBackoffPoller(task, {
      baseInterval: 1000,
      maxInterval: 8000,
      onError,
    });

    poller.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);

    expect(task.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(onError).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it('resets interval and fires onRecover when a failing poller succeeds again', async () => {
    const onRecover = vi.fn();
    let shouldFail = true;
    const task = vi.fn(async () => {
      if (shouldFail) throw new Error('down');
    });
    const poller = createBackoffPoller(task, {
      baseInterval: 1000,
      maxInterval: 8000,
      onRecover,
    });

    poller.start();
    await Promise.resolve();
    expect(poller.getCurrentInterval()).toBe(2000);

    shouldFail = false;
    await vi.advanceTimersByTimeAsync(2000);

    expect(onRecover).toHaveBeenCalledTimes(1);
    expect(poller.getCurrentInterval()).toBe(1000); // reset to base
    poller.stop();
  });

  it('stops scheduling after stop()', async () => {
    const task = vi.fn(async () => {});
    const poller = createBackoffPoller(task, { baseInterval: 1000, maxInterval: 8000 });

    poller.start();
    expect(task).toHaveBeenCalledTimes(1);
    poller.stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(task).toHaveBeenCalledTimes(1); // no further runs
  });
});
