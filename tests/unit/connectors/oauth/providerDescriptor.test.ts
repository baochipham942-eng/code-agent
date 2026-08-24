import { describe, expect, it } from 'vitest';
import {
  validateProviderDescriptor,
  type ProviderDescriptor,
} from '../../../../src/host/connectors/oauth/providerDescriptor';

function descriptor(overrides: Partial<ProviderDescriptor> = {}): ProviderDescriptor {
  return {
    id: 'example',
    displayName: 'Example',
    authorizeUrl: 'https://accounts.example.com/authorize',
    tokenUrl: 'https://api.example.com/token',
    clientId: 'client-1',
    scopes: { write: 'resource:write' },
    redirect: { mode: 'loopback-random' },
    loopbackRedirectUriSupport: 'confirmed',
    requiresClientSecret: false,
    ...overrides,
  };
}

describe('validateProviderDescriptor', () => {
  it('accepts a complete static provider descriptor', () => {
    expect(() => validateProviderDescriptor(descriptor())).not.toThrow();
  });

  it('rejects missing client configuration and unsupported loopback redirects', () => {
    expect(() => validateProviderDescriptor(descriptor({ clientId: '' })))
      .toThrow('Connector OAuth clientId is not configured for example');
    expect(() => validateProviderDescriptor(descriptor({ loopbackRedirectUriSupport: 'unsupported' })))
      .toThrow('Connector OAuth loopback redirect is unsupported for example');
  });
});
