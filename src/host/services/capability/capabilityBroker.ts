import type { CapabilityKey } from './capabilityUnitRuntime';

const EXCHANGEABLE_CAPABILITY_KEY_PATTERN = /^skill:[a-z0-9][a-z0-9._/-]*$/;

export interface CapabilityProvider<T> {
  id: string;
  isAvailable(): boolean;
  implementation: T;
}

/**
 * 表型能力的稳定消费入口。broker 自己独占 capability key，内部 provider
 * 按声明序选首个可用项，换后端不会改变消费方持有的 broker 或 key。
 */
export class CapabilityBroker<T> {
  private readonly providers: readonly CapabilityProvider<T>[];

  constructor(
    readonly key: CapabilityKey,
    providers: readonly CapabilityProvider<T>[],
  ) {
    if (!EXCHANGEABLE_CAPABILITY_KEY_PATTERN.test(key)) {
      throw new Error(`capability broker only accepts exchangeable skill keys: ${key}`);
    }
    if (providers.length === 0) {
      throw new Error(`capability broker ${key} requires at least one provider`);
    }
    const providerIds = new Set<string>();
    for (const provider of providers) {
      if (!provider.id.trim()) throw new Error(`capability broker ${key} has an empty provider id`);
      if (providerIds.has(provider.id)) {
        throw new Error(`capability broker ${key} has duplicate provider id: ${provider.id}`);
      }
      providerIds.add(provider.id);
    }
    this.providers = [...providers];
  }

  resolve(key: CapabilityKey): T {
    if (key !== this.key) {
      throw new Error(`capability broker key mismatch: expected ${this.key}, received ${key}`);
    }
    for (const provider of this.providers) {
      try {
        if (provider.isAvailable()) return provider.implementation;
      } catch {
        // A broken readiness probe makes this provider unavailable; try the next declaration.
      }
    }
    throw new Error(`no available provider for capability ${key}`);
  }
}
