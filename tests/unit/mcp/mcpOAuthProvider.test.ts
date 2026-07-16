import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

const secureStorageState = vi.hoisted(() => ({
  values: new Map<string, string>(),
  get: vi.fn((key: string) => secureStorageState.values.get(key)),
  set: vi.fn((key: string, value: string) => {
    secureStorageState.values.set(key, value);
  }),
  delete: vi.fn((key: string) => {
    secureStorageState.values.delete(key);
  }),
}));

vi.mock('../../../src/host/services/core/secureStorage', () => ({
  getSecureStorage: () => secureStorageState,
}));

import { McpOAuthProvider } from '../../../src/host/mcp/mcpOAuthProvider';

function createProvider(
  serverIdentity: string,
  onRedirectToAuthorization: (authUrl: URL) => void | Promise<void> = vi.fn(),
): McpOAuthProvider {
  return new McpOAuthProvider({
    serverIdentity,
    serverName: 'Notion',
    redirectUrl: () => 'http://127.0.0.1:49321/oauth/callback',
    state: () => 'state-abc',
    onRedirectToAuthorization,
  });
}

const notionTokens: OAuthTokens = {
  access_token: 'notion-access-token',
  token_type: 'Bearer',
  refresh_token: 'notion-refresh-token',
};

const clientInfo: OAuthClientInformationMixed = {
  client_id: 'notion-client-id',
  client_secret: 'notion-client-secret',
};

beforeEach(() => {
  secureStorageState.values.clear();
  secureStorageState.get.mockClear();
  secureStorageState.set.mockClear();
  secureStorageState.delete.mockClear();
});

describe('McpOAuthProvider', () => {
  it('roundtrips tokens through a per-server SecureStorage key', () => {
    const provider = createProvider('notion:abc123digest');

    provider.saveTokens(notionTokens);

    expect(provider.tokens()).toEqual(notionTokens);
    expect(secureStorageState.set).toHaveBeenCalledWith(
      'mcp-oauth:notion:abc123digest:tokens',
      JSON.stringify(notionTokens),
    );
    expect(secureStorageState.get).toHaveBeenCalledWith('mcp-oauth:notion:abc123digest:tokens');
  });

  it('isolates tokens across different server identities', () => {
    const notion = createProvider('notion:abc123digest');
    const linear = createProvider('linear:def456digest');

    notion.saveTokens(notionTokens);

    expect(linear.tokens()).toBeUndefined();
    expect(secureStorageState.values.has('mcp-oauth:notion:abc123digest:tokens')).toBe(true);
    expect(secureStorageState.values.has('mcp-oauth:linear:def456digest:tokens')).toBe(false);
  });

  it('does not reuse old tokens when the same server name gets a new URL digest', () => {
    const oldUrlProvider = createProvider('notion:old-url-digest');
    const newUrlProvider = createProvider('notion:new-url-digest');

    oldUrlProvider.saveTokens(notionTokens);

    expect(newUrlProvider.tokens()).toBeUndefined();
    expect(secureStorageState.values.has('mcp-oauth:notion:old-url-digest:tokens')).toBe(true);
    expect(secureStorageState.values.has('mcp-oauth:notion:new-url-digest:tokens')).toBe(false);
  });

  it('invalidates all stored credentials for a server identity', () => {
    const provider = createProvider('notion:abc123digest');

    provider.saveTokens(notionTokens);
    provider.saveClientInformation(clientInfo);
    provider.saveCodeVerifier('verifier-abc');

    provider.invalidateCredentials('all');

    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()).toBeUndefined();
    expect(() => provider.codeVerifier()).toThrow('MCP OAuth code verifier is not available');
    expect(secureStorageState.delete).toHaveBeenCalledWith('mcp-oauth:notion:abc123digest:tokens');
    expect(secureStorageState.delete).toHaveBeenCalledWith('mcp-oauth:notion:abc123digest:client-info');
    expect(secureStorageState.delete).toHaveBeenCalledWith('mcp-oauth:notion:abc123digest:code-verifier');
    expect(secureStorageState.delete).toHaveBeenCalledWith('mcp-oauth:notion:abc123digest:discovery');
  });

  it('invalidates a single credential scope without clearing the other stored entries', () => {
    const provider = createProvider('notion:abc123digest');

    provider.saveTokens(notionTokens);
    provider.saveClientInformation(clientInfo);
    provider.saveCodeVerifier('verifier-abc');

    provider.invalidateCredentials('tokens');
    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()).toEqual(clientInfo);
    expect(provider.codeVerifier()).toBe('verifier-abc');

    provider.invalidateCredentials('client');
    expect(provider.clientInformation()).toBeUndefined();
    expect(provider.codeVerifier()).toBe('verifier-abc');

    provider.invalidateCredentials('verifier');
    expect(() => provider.codeVerifier()).toThrow('MCP OAuth code verifier is not available');
  });

  it('roundtrips the PKCE code verifier through SecureStorage', () => {
    const provider = createProvider('notion:abc123digest');

    provider.saveCodeVerifier('verifier-abc');

    expect(provider.codeVerifier()).toBe('verifier-abc');
    expect(secureStorageState.set).toHaveBeenCalledWith(
      'mcp-oauth:notion:abc123digest:code-verifier',
      'verifier-abc',
    );
  });

  it('forwards authorization redirects to the injected handler', async () => {
    const onRedirectToAuthorization = vi.fn();
    const provider = createProvider('notion:abc123digest', onRedirectToAuthorization);
    const authorizationUrl = new URL('https://auth.example.com/oauth/authorize?client_id=abc');

    await provider.redirectToAuthorization(authorizationUrl);

    expect(onRedirectToAuthorization).toHaveBeenCalledTimes(1);
    expect(onRedirectToAuthorization).toHaveBeenCalledWith(authorizationUrl);
  });
});
