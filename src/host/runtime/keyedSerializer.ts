/**
 * Per-key promise chain. Later work waits for earlier work on the same key,
 * even when the earlier work rejected. Nested serialize() on the same key
 * (same async turn) runs immediately so checkpoint helpers can call each other.
 */
export function createKeyedSerializer(): <T>(key: string, work: () => Promise<T>) => Promise<T> {
  const chains = new Map<string, Promise<unknown>>();
  const depth = new Map<string, number>();

  async function run<T>(key: string, work: () => Promise<T>): Promise<T> {
    depth.set(key, (depth.get(key) ?? 0) + 1);
    try {
      return await work();
    } finally {
      depth.set(key, (depth.get(key) ?? 0) - 1);
    }
  }

  return function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    if ((depth.get(key) ?? 0) > 0) return work();
    const previous = chains.get(key) ?? Promise.resolve();
    const next = previous.then(() => run(key, work), () => run(key, work));
    chains.set(key, next.then(() => undefined, () => undefined));
    return next;
  };
}
