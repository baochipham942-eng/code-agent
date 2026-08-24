import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OAuthCoordinator } from '../../../../src/host/connectors/oauth/oauthCoordinator';

const ISSUER = 'https://auth.example.com';
const coordinators: OAuthCoordinator[] = [];

afterEach(() => {
  for (const coordinator of coordinators) coordinator.cancelAll();
  coordinators.length = 0;
});

function createCoordinator(timeoutMs = 200): OAuthCoordinator {
  const coordinator = new OAuthCoordinator({ timeoutMs, openAuthorization: vi.fn() });
  coordinators.push(coordinator);
  return coordinator;
}

function httpGet(url: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode ?? 0, body }));
    });
    request.on('error', reject);
  });
}

function callbackUrl(redirectUrl: string, params: Record<string, string>): string {
  const url = new URL(redirectUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function begin(coordinator: OAuthCoordinator, accountId = 'feishu:account-1') {
  return coordinator.beginFlow({
    accountLabel: '林晨的飞书',
    accountId,
    authorizationServerIssuer: ISSUER,
    redirect: { mode: 'loopback-random' },
  });
}

describe('OAuthCoordinator', () => {
  it('rejects a mismatched state without consuming the flow', async () => {
    const coordinator = createCoordinator();
    const flow = await begin(coordinator);
    const callback = coordinator.waitForCallback(flow.flowId);

    const mismatch = await httpGet(callbackUrl(flow.redirectUrl, {
      code: 'wrong-code',
      state: 'wrong-state',
    }));
    const pending = await Promise.race([
      callback.then(() => 'settled', () => 'settled'),
      delay(20).then(() => 'pending'),
    ]);

    expect(mismatch.statusCode).toBe(400);
    expect(pending).toBe('pending');
    await httpGet(callbackUrl(flow.redirectUrl, { code: 'right-code', state: flow.state }));
    await expect(callback).resolves.toMatchObject({ code: 'right-code' });
  });

  it('rejects a mismatched response issuer', async () => {
    const coordinator = createCoordinator();
    const flow = await begin(coordinator);
    const callback = coordinator.waitForCallback(flow.flowId);

    const response = await httpGet(callbackUrl(flow.redirectUrl, {
      code: 'must-not-be-used',
      state: flow.state,
      iss: 'https://attacker.example.net',
    }));

    expect(response.statusCode).toBe(400);
    await expect(callback).rejects.toThrow(
      `OAuth issuer mismatch: expected "${ISSUER}", received "https://attacker.example.net"`,
    );
  });

  it('times out and rejects the callback waiter', async () => {
    const coordinator = createCoordinator(15);
    const flow = await begin(coordinator);

    await expect(coordinator.waitForCallback(flow.flowId)).rejects.toThrow('OAuth flow timed out');
  });

  it('settles a matching callback only once', async () => {
    const coordinator = createCoordinator();
    const flow = await begin(coordinator);
    const settled = vi.fn();
    const callback = coordinator.waitForCallback(flow.flowId).then((result) => {
      settled(result.code);
      return result;
    });
    const url = callbackUrl(flow.redirectUrl, { code: 'only-code', state: flow.state });

    expect((await httpGet(url)).statusCode).toBe(200);
    await callback;
    await expect(httpGet(url)).rejects.toMatchObject({
      code: expect.stringMatching(/^ECONN(?:REFUSED|RESET)$/),
    });
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith('only-code');
  });

  it('fails with EADDRINUSE when a fixed loopback port is occupied', async () => {
    const blocker = http.createServer((_request, response) => response.end('occupied'));
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', resolve);
    });
    const address = blocker.address();
    if (!address || typeof address === 'string') throw new Error('Expected blocker TCP address');
    const coordinator = createCoordinator();

    try {
      await expect(coordinator.beginFlow({
        accountLabel: '林晨的飞书',
        accountId: 'feishu:fixed-port',
        authorizationServerIssuer: ISSUER,
        redirect: { mode: 'loopback-fixed', port: address.port },
      })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
