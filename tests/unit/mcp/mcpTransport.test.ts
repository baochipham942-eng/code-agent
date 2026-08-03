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
} from '@modelcontextprotocol/client';

import {
  createMCPSDKClient,
  createTransport,
  connectWithTimeout,
  isRetryableRemoteMCPConnectionError,
  resolveMCPProxyUrl,
  retryTransientRemoteMCPConnection,
} from '../../../src/host/mcp/mcpTransport';

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
        authProvider,
      },
    );
  });
});
