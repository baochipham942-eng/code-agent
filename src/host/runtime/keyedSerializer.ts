import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-key promise chain. Independent callers of the same key wait in line.
 * Nested serialize() on the same key from inside an already-held turn runs
 * immediately (ALS), so checkpoint helpers can call each other without deadlock.
 * A sibling that arrives while the holder is awaiting does NOT share that ALS
 * store and therefore queues.
 */
export function createKeyedSerializer(): <T>(key: string, work: () => Promise<T>) => Promise<T> {
  const chains = new Map<string, Promise<unknown>>();
  const heldKeys = new AsyncLocalStorage<Set<string>>();

  return function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const held = heldKeys.getStore();
    if (held?.has(key)) return work();
    const previous = chains.get(key) ?? Promise.resolve();
    const next = previous.then(() => runHeld(key, work), () => runHeld(key, work));
    const tracked = next.then(
      () => { if (chains.get(key) === tracked) chains.delete(key); },
      () => { if (chains.get(key) === tracked) chains.delete(key); },
    );
    chains.set(key, tracked);
    return next;
  };

  function runHeld<T>(key: string, work: () => Promise<T>): Promise<T> {
    const nextHeld = new Set(heldKeys.getStore());
    nextHeld.add(key);
    return heldKeys.run(nextHeld, work);
  }
}
