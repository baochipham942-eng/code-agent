import { AsyncLocalStorage } from 'node:async_hooks';

export interface MemoryModelOverride {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

const memoryModelOverrideStorage = new AsyncLocalStorage<MemoryModelOverride>();

/** Run-scoped memory routing override. Safe for concurrent compare arms; never reads global env. */
export function runWithMemoryModelOverride<T>(
  override: MemoryModelOverride | undefined,
  fn: () => T,
): T {
  if (!override) return fn();
  return memoryModelOverrideStorage.run(override, fn);
}

export function getMemoryModelOverride(): MemoryModelOverride | undefined {
  return memoryModelOverrideStorage.getStore();
}
