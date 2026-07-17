import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

const transportMocks = vi.hoisted(() => ({
  createTransport: vi.fn(),
  createMCPSDKClient: vi.fn(),
  connectWithTimeout: vi.fn(),
  retryTransientRemoteMCPConnection: vi.fn(),
}));

vi.mock('../../../src/host/mcp/mcpTransport', () => ({
  createTransport: (...args: unknown[]) => transportMocks.createTransport(...args),
  createMCPSDKClient: (...args: unknown[]) => transportMocks.createMCPSDKClient(...args),
  connectWithTimeout: (...args: unknown[]) => transportMocks.connectWithTimeout(...args),
  retryTransientRemoteMCPConnection: (...args: unknown[]) =>
    transportMocks.retryTransientRemoteMCPConnection(...args),
}));

vi.mock('../../../src/host/mcp/mcpElicitation', () => ({
  registerElicitationHandler: vi.fn(),
}));

import { MCPClient } from '../../../src/host/mcp/mcpClient';

function setupTransportMocks(error: Error) {
  const transport = { close: vi.fn().mockResolvedValue(undefined) };
  transportMocks.createTransport.mockReturnValue({
    transport,
    connectTimeout: 100,
  });
  transportMocks.createMCPSDKClient.mockReturnValue({});
  transportMocks.connectWithTimeout.mockRejectedValue(error);
  transportMocks.retryTransientRemoteMCPConnection.mockImplementation(async (attempt) => attempt(1));
}

describe('MCPClient OAuth connection errors', () => {
  beforeEach(() => {
    transportMocks.createTransport.mockReset();
    transportMocks.createMCPSDKClient.mockReset();
    transportMocks.connectWithTimeout.mockReset();
    transportMocks.retryTransientRemoteMCPConnection.mockReset();
  });

  it('marks UnauthorizedError as oauth authorization required', async () => {
    setupTransportMocks(new UnauthorizedError('login required'));
    const client = new MCPClient();
    const config = {
      name: 'oauth-http',
      type: 'http-streamable' as const,
      serverUrl: 'https://mcp.example.com/mcp',
      enabled: true,
      auth: 'oauth' as const,
    };
    client.addServer(config);

    await expect(client.connect(config)).rejects.toBeInstanceOf(UnauthorizedError);

    expect(client.getServerState('oauth-http')?.error)
      .toContain('oauth-authorization-required: login required');
    expect(transportMocks.createTransport).toHaveBeenCalledWith(
      config,
      expect.objectContaining({
        authProvider: expect.any(Object),
      }),
    );
  });

  it('does not mark ordinary connection errors as oauth authorization required', async () => {
    setupTransportMocks(new Error('connection failed'));
    const client = new MCPClient();
    const config = {
      name: 'plain-http',
      type: 'http-streamable' as const,
      serverUrl: 'https://mcp.example.com/mcp',
      enabled: true,
    };
    client.addServer(config);

    await expect(client.connect(config)).rejects.toThrow('connection failed');

    expect(client.getServerState('plain-http')?.error).toBe('connection failed');
    expect(client.getServerState('plain-http')?.error)
      .not.toContain('oauth-authorization-required');
  });
});
