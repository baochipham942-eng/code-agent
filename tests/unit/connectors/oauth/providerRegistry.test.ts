import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  descriptors: new Map<string, Record<string, unknown>>(),
  tokens: new Map<string, unknown>(),
  invalidated: vi.fn(),
}));

vi.mock('../../../../src/host/connectors/oauth/connectorOAuthStore', () => ({
  ConnectorOAuthStore: class {
    constructor(private readonly accountId: string) {}
    descriptor() { return env.descriptors.get(this.accountId); }
    saveDescriptor(descriptor: Record<string, unknown>) {
      env.descriptors.set(this.accountId, descriptor);
    }
    tokens() { return env.tokens.get(this.accountId); }
    invalidateCredentials(scope: string) { env.invalidated(this.accountId, scope); }
  },
}));

import {
  findConnectedOAuthProviderForHost,
  listOAuthProviderDescriptors,
  saveCustomOAuthProviderDescriptor,
} from '../../../../src/host/connectors/oauth/providerRegistry';

beforeEach(() => {
  env.descriptors.clear();
  env.tokens.clear();
  env.invalidated.mockClear();
});

describe('OAuth provider registry', () => {
  it('builds and re-loads the five-field runtime descriptor', () => {
    const descriptor = saveCustomOAuthProviderDescriptor({
      authorizeUrl: 'https://accounts.example.com/oauth/authorize',
      tokenUrl: 'https://api.example.com/oauth/token',
      clientId: 'client-1',
      requiresClientSecret: false,
      loopbackRedirectUriSupport: 'confirmed',
    });

    expect(descriptor).toMatchObject({
      id: 'custom-oauth',
      displayName: 'accounts.example.com',
      apiHosts: ['api.example.com'],
      scopes: { 'http.request': '' },
    });
    expect(listOAuthProviderDescriptors().at(-1)).toEqual(descriptor);
  });

  it('matches only a connected connector on its exact API host', () => {
    const descriptor = saveCustomOAuthProviderDescriptor({
      authorizeUrl: 'https://accounts.example.com/authorize',
      tokenUrl: 'https://api.example.com/token',
      clientId: 'client-1',
      requiresClientSecret: false,
      loopbackRedirectUriSupport: 'confirmed',
    });

    expect(findConnectedOAuthProviderForHost('api.example.com')).toBeUndefined();
    env.tokens.set('custom-oauth', { tokens: { access_token: 'token' } });
    expect(findConnectedOAuthProviderForHost('api.example.com')).toEqual(descriptor);
    expect(findConnectedOAuthProviderForHost('evil.api.example.com')).toBeUndefined();
  });

  it('clears old credentials before replacing a runtime descriptor', () => {
    saveCustomOAuthProviderDescriptor({
      authorizeUrl: 'https://one.example.com/authorize',
      tokenUrl: 'https://api.one.example.com/token',
      clientId: 'client-1',
      requiresClientSecret: false,
      loopbackRedirectUriSupport: 'confirmed',
    });
    saveCustomOAuthProviderDescriptor({
      authorizeUrl: 'https://two.example.com/authorize',
      tokenUrl: 'https://api.two.example.com/token',
      clientId: 'client-2',
      requiresClientSecret: true,
      loopbackRedirectUriSupport: 'confirmed',
    });

    expect(env.invalidated).toHaveBeenCalledWith('custom-oauth', 'all');
  });
});
