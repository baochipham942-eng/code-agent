import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecureStorageService } from '../../../../src/host/services/core/secureStorage';
import { ConnectorOAuthStore } from '../../../../src/host/connectors/oauth/connectorOAuthStore';

const values = new Map<string, string>();
const storage = {
  get: vi.fn((key: string) => values.get(key)),
  set: vi.fn((key: string, value: string) => { values.set(key, value); }),
  delete: vi.fn((key: string) => { values.delete(key); }),
} as unknown as SecureStorageService;

beforeEach(() => {
  values.clear();
  vi.clearAllMocks();
});

function createStore(accountId = 'feishu:account-1'): ConnectorOAuthStore {
  const store = new ConnectorOAuthStore(accountId, storage);
  store.saveDiscoveryState({
    authorizationServerUrl: 'https://accounts.feishu.cn',
    authorizationServerMetadata: {
      issuer: 'https://accounts.feishu.cn',
      authorization_endpoint: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
      token_endpoint: 'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
      response_types_supported: ['code'],
    },
  });
  return store;
}

describe('ConnectorOAuthStore', () => {
  it('stores tokens in an isolated connector-oauth key and stamps expiry', () => {
    const store = createStore();

    store.saveTokens({
      access_token: 'access-1',
      token_type: 'Bearer',
      refresh_token: 'refresh-1',
      expires_in: 120,
    }, 'im:message', 1_000);

    expect(store.tokens()).toEqual({
      tokens: {
        access_token: 'access-1',
        token_type: 'Bearer',
        refresh_token: 'refresh-1',
        expires_in: 120,
      },
      issuer: 'https://accounts.feishu.cn',
      requestedScope: 'im:message',
      expiresAt: 121_000,
    });
    expect(values.has('mcp-oauth:feishu:account-1:tokens')).toBe(false);
    expect(values.has('connector-oauth:feishu:account-1:tokens')).toBe(true);
  });

  it('keys client information by issuer and invalidates credential scopes independently', () => {
    const store = createStore();
    store.saveClientInformation({ client_id: 'cli_test' });
    store.saveCodeVerifier('verifier-1');
    store.saveTokens({ access_token: 'access-1', token_type: 'Bearer' }, 'im:message');

    expect(values.has(
      'connector-oauth:feishu:account-1:issuer:https%3A%2F%2Faccounts.feishu.cn:client-info',
    )).toBe(true);
    store.invalidateCredentials('tokens');
    expect(store.tokens()).toBeUndefined();
    expect(store.clientInformation()).toEqual({ client_id: 'cli_test' });
    expect(store.codeVerifier()).toBe('verifier-1');

    store.invalidateCredentials('all');
    expect(store.clientInformation()).toBeUndefined();
    expect(() => store.codeVerifier()).toThrow('Connector OAuth code verifier is not available');
    expect(store.discoveryState()).toBeUndefined();
  });
});
