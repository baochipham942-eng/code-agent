import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '@modelcontextprotocol/client';
import type { SecureStorageService } from '../../../../src/host/services/core/secureStorage';
import { ConnectorAuth } from '../../../../src/host/connectors/oauth/connectorAuth';
import { ConnectorOAuthStore } from '../../../../src/host/connectors/oauth/connectorOAuthStore';
import type { OAuthCoordinator, OAuthFlow } from '../../../../src/host/connectors/oauth/oauthCoordinator';
import type { ProviderDescriptor } from '../../../../src/host/connectors/oauth/providerDescriptor';

function memoryStore(accountId = 'account-1'): ConnectorOAuthStore {
  const values = new Map<string, string>();
  const storage = {
    get: (key: string) => values.get(key),
    set: (key: string, value: string) => { values.set(key, value); },
    delete: (key: string) => { values.delete(key); },
  } as unknown as SecureStorageService;
  return new ConnectorOAuthStore(accountId, storage);
}

const descriptor: ProviderDescriptor = {
  id: 'example',
  displayName: 'Example',
  authorizeUrl: 'https://accounts.example.com/oauth/authorize',
  tokenUrl: 'https://api.example.com/oauth/token',
  clientId: 'client-1',
  scopes: { write: 'resource:write' },
  extraAuthorizeParams: { audience: 'desktop' },
  redirect: { mode: 'loopback-random' },
  loopbackRedirectUriSupport: 'confirmed',
  requiresClientSecret: false,
};

const flow: OAuthFlow = {
  flowId: 'flow-1',
  accountLabel: 'Example account',
  accountId: 'account-1',
  authorizationServerIssuer: 'https://accounts.example.com',
  redirect: { mode: 'loopback-random' },
  state: 'state-1',
  redirectUrl: 'http://127.0.0.1:54321/callback',
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('ConnectorAuth', () => {
  it('orchestrates SDK authorization and appends provider parameters before opening', async () => {
    const store = memoryStore();
    const handleAuthorizationRedirect = vi.fn(
      async (_input: { accountId: string; flowId?: string; authUrl: URL }) => {},
    );
    const coordinator = {
      beginFlow: vi.fn(async () => flow),
      handleAuthorizationRedirect,
      waitForCallback: vi.fn(async () => ({
        flowId: flow.flowId,
        accountLabel: flow.accountLabel,
        accountId: flow.accountId,
        state: flow.state,
        code: 'authorization-code',
      })),
      cancelFlow: vi.fn(() => false),
    } as unknown as OAuthCoordinator;
    const fetchFn: FetchLike = vi.fn(async (_input, init) => {
      const body = init?.body as URLSearchParams;
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('authorization-code');
      expect(body.get('code_verifier')).toBeTruthy();
      return new Response(JSON.stringify({
        access_token: 'access-1',
        token_type: 'Bearer',
        refresh_token: 'refresh-1',
        expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const auth = new ConnectorAuth({
      coordinator,
      storeFactory: () => store,
      fetchFn,
      now: () => 1_000,
    });

    await expect(auth.beginFlow({
      accountId: 'account-1',
      accountLabel: 'Example account',
      descriptor,
      action: 'write',
    })).resolves.toMatchObject({ access_token: 'access-1' });

    const authorizationUrl = handleAuthorizationRedirect.mock.calls[0]?.[0]?.authUrl as URL;
    expect(authorizationUrl.searchParams.get('audience')).toBe('desktop');
    expect(authorizationUrl.searchParams.get('client_id')).toBe('client-1');
    expect(authorizationUrl.searchParams.get('state')).toBe('state-1');
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(store.tokens()).toMatchObject({
      tokens: { access_token: 'access-1' },
      requestedScope: 'resource:write',
    });
    expect(() => store.codeVerifier()).toThrow('Connector OAuth code verifier is not available');
  });

  it('refreshes an expired access token and overwrites storage', async () => {
    const store = seedExpiredStore();
    const fetchFn: FetchLike = vi.fn(async (_input, init) => {
      const body = init?.body as URLSearchParams;
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('refresh-old');
      return new Response(JSON.stringify({
        access_token: 'access-fresh',
        token_type: 'Bearer',
        expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const auth = new ConnectorAuth({
      storeFactory: () => store,
      fetchFn,
      now: () => 5_000,
    });

    await expect(auth.getAccessToken('account-1', 'resource:write')).resolves.toBe('access-fresh');
    expect(store.tokens()).toMatchObject({
      tokens: { access_token: 'access-fresh', refresh_token: 'refresh-old' },
    });
  });

  it('propagates refresh endpoint errors without overwriting the expired token', async () => {
    const store = seedExpiredStore();
    const fetchFn: FetchLike = vi.fn(async () => new Response(JSON.stringify({
      error: 'invalid_grant',
      error_description: 'refresh token expired',
    }), { status: 400, headers: { 'content-type': 'application/json' } }));
    const auth = new ConnectorAuth({
      storeFactory: () => store,
      fetchFn,
      now: () => 5_000,
    });

    await expect(auth.getAccessToken('account-1', 'resource:write'))
      .rejects.toThrow(/refresh token expired/u);
    expect(store.tokens()?.tokens.access_token).toBe('access-old');
  });
});

function seedExpiredStore(): ConnectorOAuthStore {
  const store = memoryStore();
  store.saveDiscoveryState({
    authorizationServerUrl: 'http://127.0.0.1:43210',
    authorizationServerMetadata: {
      issuer: 'http://127.0.0.1:43210',
      authorization_endpoint: 'http://127.0.0.1:43210/authorize',
      token_endpoint: 'http://127.0.0.1:43210/token',
      response_types_supported: ['code'],
    },
  });
  store.saveClientInformation({ client_id: 'client-1' });
  store.saveTokens({
    access_token: 'access-old',
    token_type: 'Bearer',
    refresh_token: 'refresh-old',
    expires_in: 1,
  }, 'resource:write', 0);
  return store;
}

describe('ConnectorAuth client secret', () => {
  it('fails closed with an actionable message when a secret-requiring provider has none stored', async () => {
    const store = memoryStore();
    const beginFlow = vi.fn(async () => flow);
    const handleAuthorizationRedirect = vi.fn(
      async (_input: { accountId: string; flowId?: string; authUrl: URL }) => {},
    );
    const auth = new ConnectorAuth({
      coordinator: { beginFlow, handleAuthorizationRedirect } as unknown as OAuthCoordinator,
      storeFactory: () => store,
    });

    await expect(auth.beginFlow({
      accountId: 'account-1',
      accountLabel: 'Example account',
      descriptor: { ...descriptor, requiresClientSecret: true },
      action: 'write',
    })).rejects.toThrow('App Secret');

    // 关键：不能把用户送到授权页去走一遍、回来才在换 token 那步吃厂商一个 400。
    expect(handleAuthorizationRedirect).not.toHaveBeenCalled();
  });

  it('prefers the stored secret over one baked into the descriptor', async () => {
    const store = memoryStore();
    store.saveClientSecret('from-secure-storage');
    const captured: Array<{ body: Record<string, unknown>; authorization?: string }> = [];
    const fetchFn = (async (_url: unknown, init: { body?: unknown; headers?: HeadersInit }) => {
      const headers = new Headers(init?.headers);
      captured.push({
        body: Object.fromEntries(new URLSearchParams(String(init?.body ?? ''))),
        ...(headers.get('authorization') ? { authorization: headers.get('authorization')! } : {}),
      });
      return new Response(
        JSON.stringify({ access_token: 'a', token_type: 'Bearer', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as FetchLike;

    const auth = new ConnectorAuth({
      coordinator: {
        beginFlow: vi.fn(async () => flow),
        handleAuthorizationRedirect: vi.fn(async () => {}),
        waitForCallback: vi.fn(async () => ({
          flowId: 'flow-1',
          accountLabel: 'Example account',
          accountId: 'account-1',
          state: 'state-1',
          code: 'code-1',
        })),
        cancelFlow: vi.fn(),
      } as unknown as OAuthCoordinator,
      storeFactory: () => store,
      fetchFn,
      now: () => 1_000,
    });

    await auth.beginFlow({
      accountId: 'account-1',
      accountLabel: 'Example account',
      descriptor: { ...descriptor, requiresClientSecret: true, clientSecret: 'baked-into-bundle' },
      action: 'write',
    });

    // 🔴 密钥不在 body 里：SDK 的 selectClientAuthMethod 在服务器没声明支持哪些认证方式时
    // 默认走 client_secret_basic，密钥进的是 Authorization 头（2026-08-24 真机也是这个形态：
    // 带 secret 那次的 body 里连 client_id 都没有了）。断言得盯真正发出去的那一处。
    const auth64 = captured.at(-1)?.authorization?.replace(/^Basic /, '') ?? '';
    const decoded = Buffer.from(auth64, 'base64').toString('utf8');
    // 本机存的密钥永远压过夹具/包里那个值，否则「改了密钥不生效」会极难查
    expect(decoded).toBe('client-1:from-secure-storage');
    expect(JSON.stringify(captured.at(-1)?.body)).not.toContain('baked-into-bundle');
  });
});
