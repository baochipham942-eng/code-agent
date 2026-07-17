import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpOAuthCoordinator } from '../../../src/host/mcp/mcpOAuthCoordinator';

let coordinators: McpOAuthCoordinator[] = [];

afterEach(() => {
  for (const coordinator of coordinators) {
    coordinator.cancelAll();
  }
  coordinators = [];
});

function createCoordinator(timeoutMs = 200): McpOAuthCoordinator {
  const coordinator = new McpOAuthCoordinator({
    timeoutMs,
    openAuthorization: vi.fn(),
  });
  coordinators.push(coordinator);
  return coordinator;
}

function httpGet(url: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          body,
        });
      });
    });
    request.on('error', reject);
  });
}

function callbackUrl(redirectUrl: string, params: Record<string, string>): string {
  const url = new URL(redirectUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRefused(url: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await httpGet(url);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') return;
      lastError = error;
    }
    await delay(10);
  }
  throw lastError instanceof Error ? lastError : new Error('Expected loopback server to close');
}

describe('McpOAuthCoordinator', () => {
  it('begins a flow with a real loopback callback port', async () => {
    const coordinator = createCoordinator();

    const flow = await coordinator.beginFlow({
      serverName: 'notion',
      serverIdentity: 'notion:abc123',
    });

    const redirectUrl = new URL(flow.redirectUrl);
    expect(redirectUrl.protocol).toBe('http:');
    expect(redirectUrl.hostname).toBe('127.0.0.1');
    expect(redirectUrl.pathname).toBe('/callback');
    expect(Number(redirectUrl.port)).toBeGreaterThan(0);
  });

  it('resolves the callback code for a matching state and closes the server', async () => {
    const coordinator = createCoordinator();
    const flow = await coordinator.beginFlow({
      serverName: 'notion',
      serverIdentity: 'notion:abc123',
    });
    const callback = coordinator.waitForCallback(flow.flowId);

    const response = await httpGet(callbackUrl(flow.redirectUrl, {
      code: 'oauth-code-1',
      state: flow.state,
    }));

    expect(response.statusCode).toBe(200);
    await expect(callback).resolves.toMatchObject({
      flowId: flow.flowId,
      serverIdentity: 'notion:abc123',
      code: 'oauth-code-1',
      state: flow.state,
    });
    await waitForRefused(flow.redirectUrl);
  });

  it('rejects a mismatched state without consuming the flow', async () => {
    const coordinator = createCoordinator();
    const flow = await coordinator.beginFlow({
      serverName: 'notion',
      serverIdentity: 'notion:abc123',
    });
    const callback = coordinator.waitForCallback(flow.flowId);

    const mismatch = await httpGet(callbackUrl(flow.redirectUrl, {
      code: 'wrong-code',
      state: 'not-the-state',
    }));
    const pending = await Promise.race([
      callback.then(() => 'resolved', () => 'rejected'),
      delay(30).then(() => 'pending'),
    ]);

    expect(mismatch.statusCode).toBe(400);
    expect(pending).toBe('pending');

    const success = await httpGet(callbackUrl(flow.redirectUrl, {
      code: 'right-code',
      state: flow.state,
    }));

    expect(success.statusCode).toBe(200);
    await expect(callback).resolves.toMatchObject({ code: 'right-code' });
  });

  it('delivers a callback code only once for repeated matching callbacks', async () => {
    const coordinator = createCoordinator();
    const flow = await coordinator.beginFlow({
      serverName: 'notion',
      serverIdentity: 'notion:abc123',
    });
    const callback = coordinator.waitForCallback(flow.flowId);
    const url = callbackUrl(flow.redirectUrl, {
      code: 'oauth-code-1',
      state: flow.state,
    });

    const first = await httpGet(url);
    const delivered = await callback;

    expect(first.statusCode).toBe(200);
    expect(delivered.code).toBe('oauth-code-1');
    await expect(httpGet(url)).rejects.toMatchObject({
      code: expect.stringMatching(/^ECONN(?:REFUSED|RESET)$/),
    });
    await expect(coordinator.waitForCallback(flow.flowId)).rejects.toThrow(`MCP OAuth flow is not active: ${flow.flowId}`);
  });

  it('rejects the callback wait on timeout and closes the server', async () => {
    const coordinator = createCoordinator(20);
    const flow = await coordinator.beginFlow({
      serverName: 'notion',
      serverIdentity: 'notion:abc123',
    });

    await expect(coordinator.waitForCallback(flow.flowId)).rejects.toThrow('MCP OAuth flow timed out');
    await waitForRefused(flow.redirectUrl);
  });

  it('reuses an in-flight flow for the same server identity', async () => {
    const coordinator = createCoordinator();

    const first = await coordinator.beginFlow({
      serverName: 'notion',
      serverIdentity: 'notion:abc123',
    });
    const second = await coordinator.beginFlow({
      serverName: 'notion-renamed',
      serverIdentity: 'notion:abc123',
    });

    expect(second).toEqual(first);
  });

  it('generates high-entropy distinct states for different flows', async () => {
    const coordinator = createCoordinator();

    const first = await coordinator.beginFlow({
      serverName: 'notion',
      serverIdentity: 'notion:abc123',
    });
    const second = await coordinator.beginFlow({
      serverName: 'linear',
      serverIdentity: 'linear:def456',
    });

    expect(first.state).not.toBe(second.state);
    expect(first.state.length).toBeGreaterThanOrEqual(32);
    expect(second.state.length).toBeGreaterThanOrEqual(32);
  });
});
