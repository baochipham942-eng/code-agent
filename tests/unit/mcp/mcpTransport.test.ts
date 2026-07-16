import { beforeEach, describe, expect, it, vi } from 'vitest';

const transportMocks = vi.hoisted(() => ({
  sseClientTransport: vi.fn(),
  streamableHTTPClientTransport: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: transportMocks.sseClientTransport,
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: transportMocks.streamableHTTPClientTransport,
}));

import {
  createTransport,
  isRetryableRemoteMCPConnectionError,
  resolveMCPProxyUrl,
  retryTransientRemoteMCPConnection,
} from '../../../src/host/mcp/mcpTransport';

describe('mcpTransport remote connection retry', () => {
  beforeEach(() => {
    transportMocks.sseClientTransport.mockClear();
    transportMocks.streamableHTTPClientTransport.mockClear();
  });

  it('retries one transient fetch failure with a fresh attempt', async () => {
    const attempt = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce('connected');

    await expect(retryTransientRemoteMCPConnection(attempt, { retryDelayMs: 0 }))
      .resolves.toBe('connected');
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(attempt).toHaveBeenNthCalledWith(1, 1);
    expect(attempt).toHaveBeenNthCalledWith(2, 2);
  });

  it('does not retry authentication failures', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('HTTP 401: invalid_token'));

    await expect(retryTransientRemoteMCPConnection(attempt, { retryDelayMs: 0 }))
      .rejects.toThrow('invalid_token');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('classifies common transient network failures without treating auth as transient', () => {
    expect(isRetryableRemoteMCPConnectionError(new TypeError('fetch failed'))).toBe(true);
    expect(isRetryableRemoteMCPConnectionError(new Error('read ECONNRESET'))).toBe(true);
    expect(isRetryableRemoteMCPConnectionError(new Error('HTTP 401: invalid_token'))).toBe(false);
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
});
