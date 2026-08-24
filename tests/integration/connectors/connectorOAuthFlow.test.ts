import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { SecureStorageService } from '../../../src/host/services/core/secureStorage';
import { ConnectorAuth } from '../../../src/host/connectors/oauth/connectorAuth';
import { ConnectorOAuthStore } from '../../../src/host/connectors/oauth/connectorOAuthStore';
import { OAuthCoordinator } from '../../../src/host/connectors/oauth/oauthCoordinator';
import type { ProviderDescriptor } from '../../../src/host/connectors/oauth/providerDescriptor';

const servers: http.Server[] = [];
const coordinators: OAuthCoordinator[] = [];

afterEach(async () => {
  for (const coordinator of coordinators) coordinator.cancelAll();
  coordinators.length = 0;
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

describe('connector OAuth local authorization server integration', () => {
  it('runs one authorization exchange and one expired-token refresh end to end', async () => {
    const grants: string[] = [];
    let baseUrl = '';
    const authorizationServer = http.createServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', baseUrl);
      if (requestUrl.pathname === '/authorize') {
        expect(requestUrl.searchParams.get('audience')).toBe('neo-desktop');
        const redirectUrl = new URL(requestUrl.searchParams.get('redirect_uri') ?? '');
        redirectUrl.searchParams.set('code', 'fake-authorization-code');
        redirectUrl.searchParams.set('state', requestUrl.searchParams.get('state') ?? '');
        console.info(`[fake-oauth] authorize -> ${redirectUrl.origin}${redirectUrl.pathname}`);
        response.writeHead(302, { location: redirectUrl.toString() });
        response.end();
        return;
      }
      if (requestUrl.pathname === '/token' && request.method === 'POST') {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => {
          const params = new URLSearchParams(body);
          const grantType = params.get('grant_type') ?? '';
          grants.push(grantType);
          response.setHeader('content-type', 'application/json');
          if (grantType === 'authorization_code') {
            expect(params.get('code')).toBe('fake-authorization-code');
            expect(params.get('code_verifier')).toBeTruthy();
            console.info('[fake-oauth] token grant=authorization_code access=access-initial expires_in=0');
            response.end(JSON.stringify({
              access_token: 'access-initial',
              token_type: 'Bearer',
              refresh_token: 'refresh-1',
              expires_in: 0,
            }));
          } else {
            expect(params.get('refresh_token')).toBe('refresh-1');
            console.info('[fake-oauth] token grant=refresh_token access=access-refreshed expires_in=3600');
            response.end(JSON.stringify({
              access_token: 'access-refreshed',
              token_type: 'Bearer',
              expires_in: 3600,
            }));
          }
        });
        return;
      }
      response.writeHead(404).end();
    });
    servers.push(authorizationServer);
    await listen(authorizationServer);
    const address = authorizationServer.address();
    if (!address || typeof address === 'string') throw new Error('Expected fake server TCP address');
    baseUrl = `http://127.0.0.1:${address.port}`;

    const store = createMemoryStore();
    const coordinator = new OAuthCoordinator({
      openAuthorization: async (authorizationUrl) => {
        const redirect = await getRedirect(authorizationUrl);
        await getStatus(redirect);
      },
    });
    coordinators.push(coordinator);
    const descriptor: ProviderDescriptor = {
      id: 'fake',
      displayName: 'Fake OAuth',
      authorizeUrl: `${baseUrl}/authorize`,
      tokenUrl: `${baseUrl}/token`,
      clientId: 'fake-client',
      scopes: { write: 'resource:write' },
      extraAuthorizeParams: { audience: 'neo-desktop' },
      redirect: { mode: 'loopback-random' },
      loopbackRedirectUriSupport: 'confirmed',
    };
    const auth = new ConnectorAuth({
      coordinator,
      storeFactory: () => store,
    });

    const initial = await auth.beginFlow({
      accountId: 'fake:account-1',
      accountLabel: 'Fake account',
      descriptor,
      action: 'write',
    });
    expect(initial.access_token).toBe('access-initial');
    await expect(auth.getAccessToken('fake:account-1', 'resource:write'))
      .resolves.toBe('access-refreshed');
    expect(grants).toEqual(['authorization_code', 'refresh_token']);
    console.info(`[fake-oauth] completed grants=${grants.join(',')}`);
  });
});

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function getRedirect(url: URL): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.resume();
      const location = response.headers.location;
      if (response.statusCode !== 302 || !location) {
        reject(new Error(`Expected authorization redirect, received ${response.statusCode}`));
        return;
      }
      response.on('end', () => resolve(location));
    });
    request.on('error', reject);
  });
}

function getStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    request.on('error', reject);
  });
}

function createMemoryStore(): ConnectorOAuthStore {
  const values = new Map<string, string>();
  const storage = {
    get: (key: string) => values.get(key),
    set: (key: string, value: string) => { values.set(key, value); },
    delete: (key: string) => { values.delete(key); },
  } as unknown as SecureStorageService;
  return new ConnectorOAuthStore('fake:account-1', storage);
}
