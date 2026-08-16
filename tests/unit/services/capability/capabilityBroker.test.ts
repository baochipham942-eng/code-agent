import { describe, expect, it } from 'vitest';
import {
  CapabilityBroker,
  type CapabilityProvider,
} from '../../../../src/host/services/capability/capabilityBroker';

interface FormatterCapability {
  format(value: string): string;
}

describe('CapabilityBroker', () => {
  it('keeps the consumer stable while selecting the first available implementation', () => {
    let primaryAvailable = true;
    const providers: CapabilityProvider<FormatterCapability>[] = [
      {
        id: 'primary',
        isAvailable: () => primaryAvailable,
        implementation: { format: (value) => value.trim().toUpperCase() },
      },
      {
        id: 'fallback',
        isAvailable: () => true,
        implementation: { format: (value) => value.trim().toLocaleUpperCase('en-US') },
      },
    ];
    const broker = new CapabilityBroker('skill:test/formatter', providers);
    const consumer = (value: string) => broker.resolve('skill:test/formatter').format(value);

    expect(consumer(' neo ')).toBe('NEO');
    expect(broker.resolve('skill:test/formatter')).toBe(providers[0]?.implementation);

    primaryAvailable = false;
    expect(consumer(' neo ')).toBe('NEO');
    expect(broker.resolve('skill:test/formatter')).toBe(providers[1]?.implementation);
  });

  it('rejects ordered or unnamespaced intervention surfaces', () => {
    const provider: CapabilityProvider<FormatterCapability> = {
      id: 'only',
      isAvailable: () => true,
      implementation: { format: (value) => value },
    };
    expect(() => new CapabilityBroker('tool:hook-chain', [provider])).toThrow(
      'only accepts exchangeable skill keys',
    );
    expect(() => new CapabilityBroker('skill:valid', [])).toThrow(
      'requires at least one provider',
    );
  });
});
