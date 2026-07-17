import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

const transportMocks = vi.hoisted(() => ({
  createTransport: vi.fn(),
  createMCPSDKClient: vi.fn(),
  connectWithTimeout: vi.fn(),
  retryTransientRemoteMCPConnection: vi.fn(),
}));
const coordinatorMocks = vi.hoisted(() => ({
  coordinator: {
    getFlowForServerIdentity: vi.fn(),
    waitForCallback: vi.fn(),
  },
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

vi.mock('../../../src/host/mcp/mcpOAuthCoordinator', () => ({
  getMcpOAuthCoordinator: () => coordinatorMocks.coordinator,
}));

import { MCPClient } from '../../../src/host/mcp/mcpClient';

function setupTransportMocks(error: Error) {
  const transport = { close: vi.fn().mockResolvedValue(undefined), finishAuth: vi.fn().mockResolvedValue(undefined) };
  transportMocks.createTransport.mockReturnValue({
    transport,
    connectTimeout: 100,
  });
  transportMocks.createMCPSDKClient.mockReturnValue({});
  transportMocks.connectWithTimeout.mockRejectedValue(error);
  transportMocks.retryTransientRemoteMCPConnection.mockImplementation(async (attempt) => attempt(1));
  return transport;
}

function mockSdkClient() {
  return {
    getServerCapabilities: vi.fn(() => ({})),
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    listResources: vi.fn().mockResolvedValue({ resources: [] }),
    listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('MCPClient OAuth connection errors', () => {
  beforeEach(() => {
    transportMocks.createTransport.mockReset();
    transportMocks.createMCPSDKClient.mockReset();
    transportMocks.connectWithTimeout.mockReset();
    transportMocks.retryTransientRemoteMCPConnection.mockReset();
    coordinatorMocks.coordinator.getFlowForServerIdentity.mockReset();
    coordinatorMocks.coordinator.waitForCallback.mockReset();
    coordinatorMocks.coordinator.getFlowForServerIdentity.mockReturnValue(undefined);
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

  it('waits for callback, calls finishAuth on the same transport, then reconnects', async () => {
    const firstTransport = {
      close: vi.fn().mockResolvedValue(undefined),
      finishAuth: vi.fn().mockResolvedValue(undefined),
    };
    const secondTransport = {
      close: vi.fn().mockResolvedValue(undefined),
      finishAuth: vi.fn().mockResolvedValue(undefined),
    };
    let resolveCallback!: (value: {
      flowId: string;
      serverName: string;
      serverIdentity: string;
      state: string;
      code: string;
    }) => void;
    const callback = new Promise<{
      flowId: string;
      serverName: string;
      serverIdentity: string;
      state: string;
      code: string;
    }>((resolve) => {
      resolveCallback = resolve;
    });
    const client = new MCPClient();
    const reconnectSpy = vi.spyOn(client, 'reconnect');
    const config = {
      name: 'oauth-http',
      type: 'http-streamable' as const,
      serverUrl: 'https://mcp.example.com/mcp',
      enabled: true,
      auth: 'oauth' as const,
    };
    const serverIdentity = client.getServerIdentity(config.name);
    expect(serverIdentity).toBeUndefined();
    client.addServer(config);
    const actualServerIdentity = client.getServerIdentity(config.name);
    expect(actualServerIdentity).toBeTruthy();

    coordinatorMocks.coordinator.getFlowForServerIdentity.mockReturnValue({ flowId: 'flow-1' });
    coordinatorMocks.coordinator.waitForCallback.mockReturnValue(callback);
    transportMocks.createTransport
      .mockReturnValueOnce({ transport: firstTransport, connectTimeout: 100 })
      .mockReturnValueOnce({ transport: secondTransport, connectTimeout: 100 });
    transportMocks.createMCPSDKClient.mockReturnValue(mockSdkClient());
    transportMocks.connectWithTimeout
      .mockRejectedValueOnce(new UnauthorizedError('login required'))
      .mockResolvedValueOnce(undefined);
    transportMocks.retryTransientRemoteMCPConnection.mockImplementation(async (attempt) => attempt(1));

    await expect(client.connect(config)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(firstTransport.close).not.toHaveBeenCalled();

    resolveCallback({
      flowId: 'flow-1',
      serverName: 'oauth-http',
      serverIdentity: actualServerIdentity!,
      state: 'state-1',
      code: 'callback-code',
    });

    await vi.waitFor(() => {
      expect(firstTransport.finishAuth).toHaveBeenCalledWith('callback-code');
      expect(reconnectSpy).toHaveBeenCalledWith('oauth-http');
    });
    expect(transportMocks.connectWithTimeout).toHaveBeenCalledTimes(2);
    expect(firstTransport.close).toHaveBeenCalled();
  });

  it('keeps the server in error state and does not reconnect when callback wait rejects', async () => {
    const firstTransport = {
      close: vi.fn().mockResolvedValue(undefined),
      finishAuth: vi.fn().mockResolvedValue(undefined),
    };
    let rejectCallback!: (error: Error) => void;
    const callback = new Promise<never>((_resolve, reject) => {
      rejectCallback = reject;
    });
    const client = new MCPClient();
    const reconnectSpy = vi.spyOn(client, 'reconnect');
    const config = {
      name: 'oauth-http',
      type: 'http-streamable' as const,
      serverUrl: 'https://mcp.example.com/mcp',
      enabled: true,
      auth: 'oauth' as const,
    };
    client.addServer(config);

    coordinatorMocks.coordinator.getFlowForServerIdentity.mockReturnValue({ flowId: 'flow-1' });
    coordinatorMocks.coordinator.waitForCallback.mockReturnValue(callback);
    transportMocks.createTransport.mockReturnValue({ transport: firstTransport, connectTimeout: 100 });
    transportMocks.createMCPSDKClient.mockReturnValue(mockSdkClient());
    transportMocks.connectWithTimeout.mockRejectedValue(new UnauthorizedError('login required'));
    transportMocks.retryTransientRemoteMCPConnection.mockImplementation(async (attempt) => attempt(1));

    await expect(client.connect(config)).rejects.toBeInstanceOf(UnauthorizedError);
    rejectCallback(new Error('MCP OAuth flow cancelled'));

    await vi.waitFor(() => {
      expect(firstTransport.close).toHaveBeenCalled();
    });
    expect(firstTransport.finishAuth).not.toHaveBeenCalled();
    expect(reconnectSpy).not.toHaveBeenCalled();
    expect(client.getServerState('oauth-http')?.status).toBe('error');
    expect(client.getServerState('oauth-http')?.error)
      .toContain('oauth-authorization-required: login required');
  });
});
