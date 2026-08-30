import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '@modelcontextprotocol/client';
import { createConnectorOAuthFetch } from '../../../../src/host/connectors/oauth/oauthFetch';

describe('createConnectorOAuthFetch', () => {
  it('routes HTTPS token requests through the configured proxy', async () => {
    const directFetch = vi.fn<FetchLike>();
    const proxyFetch = vi.fn(async () => new Response('{}', { status: 400 }));
    const oauthFetch = createConnectorOAuthFetch({
      env: { HTTPS_PROXY: 'http://127.0.0.1:7897' },
      directFetch,
      proxyFetch,
    });

    const response = await oauthFetch('https://oauth2.googleapis.com/token', { method: 'POST' });

    expect(response.status).toBe(400);
    expect(proxyFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:7897',
      'https://oauth2.googleapis.com/token',
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }),
    );
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('bypasses the proxy for NO_PROXY hosts', async () => {
    const directFetch = vi.fn(async () => new Response('{}', { status: 400 }));
    const proxyFetch = vi.fn();
    const oauthFetch = createConnectorOAuthFetch({
      env: {
        HTTPS_PROXY: 'http://127.0.0.1:7897',
        NO_PROXY: 'oauth2.googleapis.com',
      },
      directFetch,
      proxyFetch,
    });

    await oauthFetch('https://oauth2.googleapis.com/token');

    expect(directFetch).toHaveBeenCalledOnce();
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it('normalizes a response from the external undici implementation', async () => {
    const foreignResponse = {
      arrayBuffer: async () => new TextEncoder().encode('{"error":"invalid_grant"}').buffer,
      headers: new Map([['content-type', 'application/json']]),
      status: 400,
      statusText: 'Bad Request',
    } as unknown as Response;
    const oauthFetch = createConnectorOAuthFetch({
      env: { HTTPS_PROXY: 'http://127.0.0.1:7897' },
      proxyFetch: vi.fn(async () => foreignResponse),
    });

    const response = await oauthFetch('https://oauth2.googleapis.com/token');

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_grant' });
  });

  it('turns a stalled token request into a concrete timeout reason', async () => {
    const directFetch: FetchLike = vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const oauthFetch = createConnectorOAuthFetch({ env: {}, timeoutMs: 10, directFetch });

    await expect(oauthFetch('https://oauth2.googleapis.com/token'))
      .rejects.toThrow('连接 oauth2.googleapis.com 超过 1 秒没有响应');
  });
});
