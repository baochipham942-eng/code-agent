import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transportMocks = vi.hoisted(() => ({
  client: vi.fn(),
  sseClientTransport: vi.fn(),
  streamableHTTPClientTransport: vi.fn(),
}));

vi.mock('@modelcontextprotocol/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@modelcontextprotocol/client')>(),
  Client: transportMocks.client,
  SSEClientTransport: transportMocks.sseClientTransport,
  StreamableHTTPClientTransport: transportMocks.streamableHTTPClientTransport,
}));

import {
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  type FetchLike,
} from '@modelcontextprotocol/client';

import {
  createMCPSDKClient,
  createTransport,
  connectWithTimeout,
  isRetryableRemoteMCPConnectionError,
  resolveMCPProxyUrl,
  retryTransientRemoteMCPConnection,
} from '../../../src/host/mcp/mcpTransport';
import { createConnectorOAuthFetch } from '../../../src/host/connectors/oauth/oauthFetch';

describe('mcpTransport remote connection retry', () => {
  beforeEach(() => {
    transportMocks.sseClientTransport.mockClear();
    transportMocks.streamableHTTPClientTransport.mockClear();
    transportMocks.client.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('enables automatic v2 negotiation with legacy fallback', () => {
    createMCPSDKClient();

    expect(transportMocks.client).toHaveBeenCalledWith(
      { name: 'code-agent', version: '0.1.0' },
      expect.objectContaining({
        versionNegotiation: { mode: 'auto' },
        capabilities: expect.objectContaining({
          extensions: {
            'io.modelcontextprotocol/tasks': {},
          },
        }),
        responseCacheStore: expect.anything(),
        defaultCacheTtlMs: 30_000,
      }),
    );
  });

  it('retries one transient fetch failure with a fresh attempt', async () => {
    const attempt = vi.fn()
      .mockRejectedValueOnce(new SdkError(SdkErrorCode.RequestTimeout, 'request timed out'))
      .mockResolvedValueOnce('connected');

    await expect(retryTransientRemoteMCPConnection(attempt, { retryDelayMs: 0 }))
      .resolves.toBe('connected');
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(attempt).toHaveBeenNthCalledWith(1, 1);
    expect(attempt).toHaveBeenNthCalledWith(2, 2);
  });

  it('emits a structured SDK timeout when the connection deadline wins', async () => {
    vi.useFakeTimers();
    const pending = connectWithTimeout(
      { connect: vi.fn(() => new Promise<void>(() => {})) } as never,
      { close: vi.fn().mockResolvedValue(undefined) } as never,
      {
        name: 'slow-http',
        type: 'http-streamable',
        serverUrl: 'https://mcp.example.com/mcp',
        enabled: true,
      },
      25,
    );
    const rejection = expect(pending).rejects.toMatchObject({
      code: SdkErrorCode.RequestTimeout,
    });

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
  });

  it('closes the transport and reports AbortError when a connection is cancelled', async () => {
    const controller = new AbortController();
    const close = vi.fn().mockResolvedValue(undefined);
    const pending = connectWithTimeout(
      { connect: vi.fn(() => new Promise<void>(() => {})) } as never,
      { close } as never,
      {
        name: 'cancelled-http',
        type: 'http-streamable',
        serverUrl: 'https://mcp.example.com/mcp',
        enabled: true,
      },
      30_000,
      controller.signal,
    );

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not retry authentication failures', async () => {
    const attempt = vi.fn().mockRejectedValue(new SdkHttpError(
      SdkErrorCode.ClientHttpAuthentication,
      'invalid_token',
      { status: 401 },
    ));

    await expect(retryTransientRemoteMCPConnection(attempt, { retryDelayMs: 0 }))
      .rejects.toThrow('invalid_token');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('classifies common transient network failures without treating auth as transient', () => {
    const reset = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
    const timeout = new SdkError(SdkErrorCode.RequestTimeout, 'request timed out');
    const unauthorized = new SdkHttpError(
      SdkErrorCode.ClientHttpAuthentication,
      'invalid_token',
      { status: 401 },
    );

    expect(isRetryableRemoteMCPConnectionError(timeout)).toBe(true);
    expect(isRetryableRemoteMCPConnectionError(reset)).toBe(true);
    expect(isRetryableRemoteMCPConnectionError(unauthorized)).toBe(false);
  });

  it('uses the HTTPS proxy for remote MCP and respects local and NO_PROXY targets', () => {
    const env = {
      HTTPS_PROXY: 'http://127.0.0.1:7897',
      NO_PROXY: 'context7.com,.internal.example',
    };

    expect(resolveMCPProxyUrl(new URL('https://mcp.exa.ai/mcp'), env))
      .toBe('http://127.0.0.1:7897');
    expect(resolveMCPProxyUrl(new URL('https://context7.com/mcp'), env)).toBeUndefined();
    expect(resolveMCPProxyUrl(new URL('https://api.internal.example/mcp'), env)).toBeUndefined();
    expect(resolveMCPProxyUrl(new URL('http://127.0.0.1:8180/mcp'), env)).toBeUndefined();
  });

  it('passes SSE headers through requestInit for SDK shared GET and POST headers', () => {
    createTransport({
      name: 'auth-sse',
      type: 'sse',
      serverUrl: 'https://mcp.example.com/sse',
      enabled: true,
      headers: { Authorization: 'Bearer test-token-abc' },
    });

    expect(transportMocks.sseClientTransport).toHaveBeenCalledTimes(1);
    expect(transportMocks.sseClientTransport).toHaveBeenCalledWith(
      new URL('https://mcp.example.com/sse'),
      {
        requestInit: {
          headers: { Authorization: 'Bearer test-token-abc' },
        },
        eventSourceInit: {},
        fetch: expect.any(Function),
      },
    );
  });

  it('does not pass SSE requestInit when no headers are configured', () => {
    createTransport({
      name: 'plain-sse',
      type: 'sse',
      serverUrl: 'https://mcp.example.com/sse',
      enabled: true,
    });

    expect(transportMocks.sseClientTransport).toHaveBeenCalledTimes(1);
    expect(transportMocks.sseClientTransport).toHaveBeenCalledWith(
      new URL('https://mcp.example.com/sse'),
      {
        eventSourceInit: {},
        fetch: expect.any(Function),
      },
    );
  });

  it('keeps HTTP streamable headers on requestInit', () => {
    createTransport({
      name: 'auth-http',
      type: 'http-streamable',
      serverUrl: 'https://mcp.example.com/mcp',
      enabled: true,
      headers: { Authorization: 'Bearer test-token-abc' },
    });

    expect(transportMocks.streamableHTTPClientTransport).toHaveBeenCalledTimes(1);
    expect(transportMocks.streamableHTTPClientTransport).toHaveBeenCalledWith(
      new URL('https://mcp.example.com/mcp'),
      {
        requestInit: {
          headers: { Authorization: 'Bearer test-token-abc' },
        },
        fetch: expect.any(Function),
      },
    );
  });

  it('passes authProvider only to HTTP streamable transport when configured', () => {
    const authProvider = { tokens: vi.fn() };

    createTransport({
      name: 'oauth-http',
      type: 'http-streamable',
      serverUrl: 'https://mcp.example.com/mcp',
      enabled: true,
      auth: 'oauth',
    }, { authProvider: authProvider as never });

    expect(transportMocks.streamableHTTPClientTransport).toHaveBeenCalledTimes(1);
    expect(transportMocks.streamableHTTPClientTransport).toHaveBeenCalledWith(
      new URL('https://mcp.example.com/mcp'),
      {
        requestInit: {},
        fetch: expect.any(Function),
        authProvider,
      },
    );
  });

  it('does not include authProvider when no authProvider option is passed', () => {
    createTransport({
      name: 'plain-http',
      type: 'http-streamable',
      serverUrl: 'https://mcp.example.com/mcp',
      enabled: true,
    });

    expect(transportMocks.streamableHTTPClientTransport).toHaveBeenCalledTimes(1);
    expect(transportMocks.streamableHTTPClientTransport).toHaveBeenCalledWith(
      new URL('https://mcp.example.com/mcp'),
      {
        requestInit: {},
        fetch: expect.any(Function),
      },
    );
  });

  it('does not pass authProvider to SSE transport even when the option is present', () => {
    const authProvider = { tokens: vi.fn() };

    createTransport({
      name: 'sse-no-oauth',
      type: 'sse',
      serverUrl: 'https://mcp.example.com/sse',
      enabled: true,
    }, { authProvider: authProvider as never });

    expect(transportMocks.sseClientTransport).toHaveBeenCalledTimes(1);
    expect(transportMocks.sseClientTransport).toHaveBeenCalledWith(
      new URL('https://mcp.example.com/sse'),
      {
        eventSourceInit: {},
        fetch: expect.any(Function),
      },
    );
  });

  it('removes configured Authorization headers when OAuth provider is injected', () => {
    const authProvider = { tokens: vi.fn() };

    createTransport({
      name: 'oauth-http-with-headers',
      type: 'http-streamable',
      serverUrl: 'https://mcp.example.com/mcp',
      enabled: true,
      auth: 'oauth',
      headers: {
        Authorization: 'Bearer static-token',
        'X-Trace': 'trace-id',
        authorization: 'Bearer lower-token',
      },
    }, { authProvider: authProvider as never });

    expect(transportMocks.streamableHTTPClientTransport).toHaveBeenCalledWith(
      new URL('https://mcp.example.com/mcp'),
      {
        requestInit: {
          headers: { 'X-Trace': 'trace-id' },
        },
        fetch: expect.any(Function),
        authProvider,
      },
    );
  });
});

describe('createRemoteMCPFetch OAuth timeout', () => {
  beforeEach(() => {
    transportMocks.sseClientTransport.mockClear();
    transportMocks.streamableHTTPClientTransport.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('bounds OAuth outbound with a timeout abort even on the first connect (no proxy)', async () => {
    // 首连（useProxy=false，对应 attemptNumber=1）注入的 fetch 也必须给 OAuth 出站加超时：
    // 假 fetch 永不 resolve，只有超时 abort 能让它失败，且失败原因沿用 oauthFetch 的中文句式。
    const stalledFetchSignals: AbortSignal[] = [];
    const stalledFetch: FetchLike = (_url, init) => new Promise<Response>((_resolve, reject) => {
      stalledFetchSignals.push(init?.signal as AbortSignal);
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
    vi.stubGlobal('fetch', vi.fn());

    createTransport({
      name: 'first-connect-oauth',
      type: 'http-streamable',
      serverUrl: 'https://mcp.example.com/mcp',
      enabled: true,
      auth: 'oauth',
    }, {
      useProxy: false,
      oauthFetch: createConnectorOAuthFetch({ env: {}, timeoutMs: 10, directFetch: stalledFetch }),
    });

    expect(transportMocks.streamableHTTPClientTransport).toHaveBeenCalledTimes(1);
    const transportOptions = transportMocks.streamableHTTPClientTransport.mock.calls[0][1] as { fetch: FetchLike };

    await expect(transportOptions.fetch('https://auth.example.com/token', { method: 'POST' }))
      .rejects.toThrow('连接 auth.example.com 超过 1 秒没有响应');
    expect(stalledFetchSignals).toHaveLength(1);
    expect(stalledFetchSignals[0].aborted).toBe(true);
  });

  it('keeps signal-carrying session requests off the OAuth timeout path', async () => {
    // 会话流量（initialize POST、Streamable GET 长流、SSE 流）带 abort signal，不允许叠加
    // 响应截止时间：signal 必须原样透传（同一实例、未被 AbortSignal.any 包装）。
    const sessionFetch = vi.fn(async () => new Response('ok'));
    const oauthFetch = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', sessionFetch);

    createTransport({
      name: 'session-stream',
      type: 'http-streamable',
      serverUrl: 'https://mcp.example.com/mcp',
      enabled: true,
    }, { useProxy: false, oauthFetch });

    const transportOptions = transportMocks.streamableHTTPClientTransport.mock.calls[0][1] as { fetch: FetchLike };
    const controller = new AbortController();

    await transportOptions.fetch('https://mcp.example.com/mcp', {
      method: 'GET',
      signal: controller.signal,
    });

    expect(sessionFetch).toHaveBeenCalledTimes(1);
    const firstCall = sessionFetch.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(firstCall[0]).toBe('https://mcp.example.com/mcp');
    expect(firstCall[1]?.signal).toBe(controller.signal);
    expect(controller.signal.aborted).toBe(false);
    expect(oauthFetch).not.toHaveBeenCalled();
  });

  it('routes signal-less OAuth outbound through the bounded OAuth fetch unchanged', async () => {
    const oauthFetch = vi.fn(async () => new Response('{}'));
    createTransport({
      name: 'oauth-discovery',
      type: 'http-streamable',
      serverUrl: 'https://mcp.example.com/mcp',
      enabled: true,
    }, { useProxy: false, oauthFetch });
    const transportOptions = transportMocks.streamableHTTPClientTransport.mock.calls[0][1] as { fetch: FetchLike };

    await transportOptions.fetch('https://auth.example.com/.well-known/oauth-protected-resource');
    expect(oauthFetch).toHaveBeenCalledTimes(1);
    expect(oauthFetch).toHaveBeenCalledWith(
      'https://auth.example.com/.well-known/oauth-protected-resource',
      undefined,
    );
  });

  it('preserves wrapped network TypeError so SDK discovery can retry via proxy', async () => {
    const networkError = new TypeError('fetch failed');
    Object.assign(networkError, { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
    const oauthFetch = vi.fn(async () => {
      throw new Error('无法连接 auth.example.com：fetch failed', { cause: networkError });
    });
    createTransport({
      name: 'oauth-reset',
      type: 'http-streamable',
      serverUrl: 'https://mcp.example.com/mcp',
      enabled: true,
    }, { useProxy: false, oauthFetch });
    const transportOptions = transportMocks.streamableHTTPClientTransport.mock.calls[0][1] as { fetch: FetchLike };

    await expect(transportOptions.fetch('https://auth.example.com/.well-known/oauth-protected-resource'))
      .rejects.toBe(networkError);
    expect(isRetryableRemoteMCPConnectionError(networkError)).toBe(true);
  });
});
