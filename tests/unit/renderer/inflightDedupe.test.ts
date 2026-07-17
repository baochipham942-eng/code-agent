import { describe, expect, it, vi } from 'vitest';
import { createInflightDedupe } from '../../../src/renderer/utils/inflightDedupe';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createInflightDedupe', () => {
  it('collapses concurrent identical calls into a single underlying invocation', async () => {
    const d = deferred<string>();
    const fn = vi.fn((_key: string) => d.promise);
    const wrapped = createInflightDedupe(fn, (k: string) => k);

    const p1 = wrapped('settings:get');
    const p2 = wrapped('settings:get');
    const p3 = wrapped('settings:get');

    expect(fn).toHaveBeenCalledTimes(1);

    d.resolve('value');
    await expect(p1).resolves.toBe('value');
    await expect(p2).resolves.toBe('value');
    await expect(p3).resolves.toBe('value');
  });

  it('does not dedupe calls with different keys', async () => {
    const fn = vi.fn(async (k: string) => k);
    const wrapped = createInflightDedupe(fn, (k: string) => k);

    await Promise.all([wrapped('a'), wrapped('b')]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('re-invokes after the previous call settles (no stale caching)', async () => {
    const fn = vi.fn(async (k: string) => k);
    const wrapped = createInflightDedupe(fn, (k: string) => k);

    await wrapped('settings:get');
    await wrapped('settings:get');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('clears the in-flight entry on rejection so the next call retries', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('ok');
    const wrapped = createInflightDedupe(fn, () => 'k');

    await expect(wrapped()).rejects.toThrow('boom');
    await expect(wrapped()).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('bypasses dedupe when keyOf returns null (e.g. writes)', () => {
    const fn = vi.fn(() => deferred<void>().promise);
    const wrapped = createInflightDedupe(fn, () => null);

    void wrapped();
    void wrapped();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
