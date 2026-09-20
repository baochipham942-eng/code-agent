import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPClient } from '../../../src/host/mcp/mcpClient';
import { MCPToolRegistry } from '../../../src/host/mcp/mcpToolRegistry';

function connectedClient(now: () => number) {
  const client = new MCPClient({
    idleReaping: { ttlMs: 100, scanIntervalMs: 25 },
    now,
  });
  const sdkClient = { close: vi.fn(async () => {}) };
  const clients = (client as unknown as { clients: Map<string, unknown> }).clients;
  clients.set('remote', sdkClient);
  (client as unknown as { serverConfigs: Map<string, unknown> }).serverConfigs.set('remote', {
    name: 'remote', type: 'http-streamable', serverUrl: 'https://example.test/mcp', enabled: true,
  });
  (client as unknown as { serverStates: Map<string, unknown> }).serverStates.set('remote', {
    config: { name: 'remote', type: 'http-streamable', serverUrl: 'https://example.test/mcp', enabled: true },
    status: 'connected', toolCount: 0, resourceCount: 0,
  });
  (client as unknown as { idleReaper: { lastUsedAt: Map<string, number> } }).idleReaper.lastUsedAt.set('remote', 0);
  return { client, sdkClient };
}

describe('MCPClient idle connection reaping', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('can disable reaping through the MCP settings boundary', async () => {
    let now = 0;
    const client = new MCPClient({ idleReaping: { enabled: false, ttlMs: 1, scanIntervalMs: 1 }, now: () => now });
    const sdkClient = { close: vi.fn(async () => {}) };
    (client as unknown as { clients: Map<string, unknown> }).clients.set('remote', sdkClient);
    (client as unknown as { idleReaper: { lastUsedAt: Map<string, number> } }).idleReaper.lastUsedAt.set('remote', 0);
    now = 100;
    await vi.advanceTimersByTimeAsync(100);
    expect(sdkClient.close).not.toHaveBeenCalled();
    client.configureIdleReaping({ enabled: true, ttlMs: 1, scanIntervalMs: 1 });
    await vi.advanceTimersByTimeAsync(1);
    expect(sdkClient.close).toHaveBeenCalledOnce();
  });

  it('reaps an idle connection and the next lazy operation reconnects', async () => {
    let now = 0;
    const { client, sdkClient } = connectedClient(() => now);
    const connect = vi.spyOn(client, 'connect').mockImplementation(async (config) => {
      (client as unknown as { clients: Map<string, unknown> }).clients.set(config.name, sdkClient);
    });
    now = 100;
    await vi.advanceTimersByTimeAsync(25);
    expect(sdkClient.close).toHaveBeenCalledOnce();
    expect(client.isConnected('remote')).toBe(false);

    const registry = (client as unknown as { registry: MCPToolRegistry }).registry;
    vi.spyOn(registry, 'readExternalResource').mockResolvedValue('resource');
    await expect(client.readResource('remote', 'mcp://resource')).resolves.toBe('resource');
    expect(connect).toHaveBeenCalledOnce();
  });

  it('does not reap an active request or a valid durable task lease', async () => {
    let now = 0;
    const { client } = connectedClient(() => now);
    const registry = (client as unknown as { registry: MCPToolRegistry }).registry;
    let finish!: () => void;
    vi.spyOn(registry, 'readExternalResource').mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve('resource');
    }));
    const pending = client.readResource('remote', 'mcp://resource');
    now = 100;
    await vi.advanceTimersByTimeAsync(100);
    expect(client.isConnected('remote')).toBe(true);
    finish();
    await pending;

    client.acquireConnectionLease('remote', 'task-1');
    now = 500;
    await vi.advanceTimersByTimeAsync(100);
    expect(client.isConnected('remote')).toBe(true);
    client.releaseConnectionLease('remote', 'task-1');
    now = 700;
    await vi.advanceTimersByTimeAsync(100);
    expect(client.isConnected('remote')).toBe(false);
  });

  it('releases request usage after a read error so close can still reap', async () => {
    let now = 0;
    const { client } = connectedClient(() => now);
    const registry = (client as unknown as { registry: MCPToolRegistry }).registry;
    vi.spyOn(registry, 'getExternalPrompt').mockRejectedValue(new Error('prompt failed'));
    await expect(client.getPrompt('remote', 'prompt')).rejects.toThrow('prompt failed');
    now = 100;
    await vi.advanceTimersByTimeAsync(25);
    expect(client.isConnected('remote')).toBe(false);
  });

  it('reconnects lazy prompt reads after a reap without treating them as tool calls', async () => {
    let now = 0;
    const { client, sdkClient } = connectedClient(() => now);
    const connect = vi.spyOn(client, 'connect').mockImplementation(async (config) => {
      (client as unknown as { clients: Map<string, unknown> }).clients.set(config.name, sdkClient);
    });
    const registry = (client as unknown as { registry: MCPToolRegistry }).registry;
    vi.spyOn(registry, 'getExternalPrompt').mockResolvedValue('prompt');
    now = 100;
    await vi.advanceTimersByTimeAsync(25);
    await expect(client.getPrompt('remote', 'prompt')).resolves.toBe('prompt');
    expect(connect).toHaveBeenCalledOnce();
  });

  it('keeps a durable task protocol recoverable after its server was reaped', async () => {
    let now = 0;
    const { client, sdkClient } = connectedClient(() => now);
    const request = vi.fn(async () => ({
      task: {
        taskId: 'task-1', status: 'working', ttl: 10_000,
        createdAt: '2026-09-20T00:00:00Z', lastUpdatedAt: '2026-09-20T00:00:00Z',
      },
    }));
    (sdkClient as { request?: typeof request }).request = request;
    const connect = vi.spyOn(client, 'connect').mockImplementation(async (config) => {
      (client as unknown as { clients: Map<string, unknown> }).clients.set(config.name, sdkClient);
    });
    now = 100;
    await vi.advanceTimersByTimeAsync(25);
    const identity = client.getServerIdentity('remote');
    if (!identity) throw new Error('expected server identity');
    const protocol = client.createTaskProtocol('remote', identity);
    expect(protocol).not.toBeNull();
    await expect(protocol?.getTask({ serverIdentity: identity, taskId: 'task-1' })).resolves.toMatchObject({ taskId: 'task-1' });
    expect(connect).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
  });

  it('refreshes a protocol created before idle reap instead of using the closed client', async () => {
    let now = 0;
    const { client, sdkClient: oldClient } = connectedClient(() => now);
    const taskEnvelope = {
      task: {
        taskId: 'task-1', status: 'working', ttl: 10_000,
        createdAt: '2026-09-20T00:00:00Z', lastUpdatedAt: '2026-09-20T00:00:00Z',
      },
    };
    const oldRequest = vi.fn(async () => taskEnvelope);
    (oldClient as { request?: typeof oldRequest }).request = oldRequest;
    const newClient = { request: vi.fn(async () => taskEnvelope), close: vi.fn(async () => {}) };
    vi.spyOn(client, 'connect').mockImplementation(async (config) => {
      (client as unknown as { clients: Map<string, unknown> }).clients.set(config.name, newClient);
    });
    const identity = client.getServerIdentity('remote');
    if (!identity) throw new Error('expected server identity');
    const protocol = client.createTaskProtocol('remote', identity);
    expect(protocol).not.toBeNull();

    now = 100;
    await vi.advanceTimersByTimeAsync(25);
    await expect(protocol?.getTask({ serverIdentity: identity, taskId: 'task-1' })).resolves.toMatchObject({ taskId: 'task-1' });

    expect(oldRequest).not.toHaveBeenCalled();
    expect(newClient.request).toHaveBeenCalledOnce();
  });
});
