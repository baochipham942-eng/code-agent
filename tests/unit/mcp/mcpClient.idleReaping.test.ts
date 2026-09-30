import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPClient } from '../../../src/host/mcp/mcpClient';
import { MCPToolRegistry } from '../../../src/host/mcp/mcpToolRegistry';
import { MCP_TIMEOUTS } from '../../../src/shared/constants/timeouts';

// Reap 候选必须显式 stateless，并且能懒加载回来（stdio 且未关闭 lazyLoad）。
// 用这个当默认夹具——它是 isReapable() 判真的那一类。
const REAPABLE_STDIO = {
  name: 'local', type: 'stdio' as const, command: 'echo', args: ['hi'], enabled: true, stateless: true,
};

function connectedClient(now: () => number) {
  const client = new MCPClient({
    idleReaping: { enabled: true, ttlMs: 100, scanIntervalMs: 25 },
    now,
  });
  const sdkClient = { close: vi.fn(async () => {}) };
  const clients = (client as unknown as { clients: Map<string, unknown> }).clients;
  clients.set('local', sdkClient);
  (client as unknown as { serverConfigs: Map<string, unknown> }).serverConfigs.set('local', REAPABLE_STDIO);
  (client as unknown as { serverStates: Map<string, unknown> }).serverStates.set('local', {
    config: REAPABLE_STDIO,
    status: 'connected', toolCount: 0, resourceCount: 0,
  });
  (client as unknown as { idleReaper: { lastUsedAt: Map<string, number> } }).idleReaper.lastUsedAt.set('local', 0);
  return { client, sdkClient };
}

describe('MCPClient idle connection reaping', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('can disable reaping through the MCP settings boundary', async () => {
    let now = 0;
    const client = new MCPClient({ idleReaping: { enabled: false, ttlMs: 1, scanIntervalMs: 1 }, now: () => now });
    const sdkClient = { close: vi.fn(async () => {}) };
    (client as unknown as { clients: Map<string, unknown> }).clients.set('local', sdkClient);
    (client as unknown as { serverConfigs: Map<string, unknown> }).serverConfigs.set('local', {
      name: 'local', type: 'stdio', command: 'echo', enabled: true, stateless: true,
    });
    (client as unknown as { idleReaper: { lastUsedAt: Map<string, number> } }).idleReaper.lastUsedAt.set('local', 0);
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
    expect(client.isConnected('local')).toBe(false);

    const registry = (client as unknown as { registry: MCPToolRegistry }).registry;
    vi.spyOn(registry, 'readExternalResource').mockResolvedValue('resource');
    await expect(client.readResource('local', 'mcp://resource')).resolves.toBe('resource');
    expect(connect).toHaveBeenCalledOnce();
  });

  it('flips status to lazy (not disconnected) after a reap, keeping it usable for scope', async () => {
    let now = 0;
    const { client } = connectedClient(() => now);
    vi.spyOn(client, 'connect').mockResolvedValue(undefined);
    now = 100;
    await vi.advanceTimersByTimeAsync(25);
    const state = client.getServerStates().find((s) => s.config.name === 'local');
    expect(state?.status).toBe('lazy');
  });

  it('does not reap a server that cannot be lazy-loaded back (remote http-streamable)', async () => {
    let now = 0;
    const client = new MCPClient({ idleReaping: { enabled: true, ttlMs: 100, scanIntervalMs: 25 }, now: () => now });
    const sdkClient = { close: vi.fn(async () => {}) };
    (client as unknown as { clients: Map<string, unknown> }).clients.set('remote', sdkClient);
    (client as unknown as { serverConfigs: Map<string, unknown> }).serverConfigs.set('remote', {
      name: 'remote', type: 'http-streamable', serverUrl: 'https://example.test/mcp', enabled: true,
    });
    (client as unknown as { serverStates: Map<string, unknown> }).serverStates.set('remote', {
      config: { name: 'remote', type: 'http-streamable', serverUrl: 'https://example.test/mcp', enabled: true },
      status: 'connected', toolCount: 0, resourceCount: 0,
    });
    (client as unknown as { idleReaper: { lastUsedAt: Map<string, number> } }).idleReaper.lastUsedAt.set('remote', 0);

    now = 500;
    await vi.advanceTimersByTimeAsync(500);
    expect(sdkClient.close).not.toHaveBeenCalled();
    expect(client.isConnected('remote')).toBe(true);
  });

  it('does not reap a stdio server with lazyLoad explicitly disabled', async () => {
    let now = 0;
    const client = new MCPClient({ idleReaping: { enabled: true, ttlMs: 100, scanIntervalMs: 25 }, now: () => now });
    const sdkClient = { close: vi.fn(async () => {}) };
    (client as unknown as { clients: Map<string, unknown> }).clients.set('eager', sdkClient);
    (client as unknown as { serverConfigs: Map<string, unknown> }).serverConfigs.set('eager', {
      name: 'eager', type: 'stdio', command: 'echo', enabled: true, lazyLoad: false,
    });
    (client as unknown as { serverStates: Map<string, unknown> }).serverStates.set('eager', {
      config: { name: 'eager', type: 'stdio', command: 'echo', enabled: true, lazyLoad: false },
      status: 'connected', toolCount: 0, resourceCount: 0,
    });
    (client as unknown as { idleReaper: { lastUsedAt: Map<string, number> } }).idleReaper.lastUsedAt.set('eager', 0);

    now = 500;
    await vi.advanceTimersByTimeAsync(500);
    expect(sdkClient.close).not.toHaveBeenCalled();
    expect(client.isConnected('eager')).toBe(true);
  });

  it('does not reap an active request or a valid durable task lease', async () => {
    let now = 0;
    const { client } = connectedClient(() => now);
    const registry = (client as unknown as { registry: MCPToolRegistry }).registry;
    let finish!: () => void;
    vi.spyOn(registry, 'readExternalResource').mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve('resource');
    }));
    const pending = client.readResource('local', 'mcp://resource');
    now = 100;
    await vi.advanceTimersByTimeAsync(100);
    expect(client.isConnected('local')).toBe(true);
    finish();
    await pending;

    client.acquireConnectionLease('local', 'task-1');
    now = 500;
    await vi.advanceTimersByTimeAsync(100);
    expect(client.isConnected('local')).toBe(true);
    client.releaseConnectionLease('local', 'task-1');
    now = 700;
    await vi.advanceTimersByTimeAsync(100);
    expect(client.isConnected('local')).toBe(false);
  });

  it('releases request usage after a read error so close can still reap', async () => {
    let now = 0;
    const { client } = connectedClient(() => now);
    const registry = (client as unknown as { registry: MCPToolRegistry }).registry;
    vi.spyOn(registry, 'getExternalPrompt').mockRejectedValue(new Error('prompt failed'));
    await expect(client.getPrompt('local', 'prompt')).rejects.toThrow('prompt failed');
    now = 100;
    await vi.advanceTimersByTimeAsync(25);
    expect(client.isConnected('local')).toBe(false);
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
    await expect(client.getPrompt('local', 'prompt')).resolves.toBe('prompt');
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
    const identity = client.getServerIdentity('local');
    if (!identity) throw new Error('expected server identity');
    const protocol = client.createTaskProtocol('local', identity);
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
    const identity = client.getServerIdentity('local');
    if (!identity) throw new Error('expected server identity');
    const protocol = client.createTaskProtocol('local', identity);
    expect(protocol).not.toBeNull();

    now = 100;
    await vi.advanceTimersByTimeAsync(25);
    await expect(protocol?.getTask({ serverIdentity: identity, taskId: 'task-1' })).resolves.toMatchObject({ taskId: 'task-1' });

    expect(oldRequest).not.toHaveBeenCalled();
    expect(newClient.request).toHaveBeenCalledOnce();
  });

  it('treats an explicit scanIntervalMs of 0 as unconfigured instead of a 1ms scan cadence', async () => {
    let now = 0;
    const client = new MCPClient({ idleReaping: { enabled: true, ttlMs: 100, scanIntervalMs: 0 }, now: () => now });
    const sdkClient = { close: vi.fn(async () => {}) };
    (client as unknown as { clients: Map<string, unknown> }).clients.set('local', sdkClient);
    (client as unknown as { serverConfigs: Map<string, unknown> }).serverConfigs.set('local', {
      name: 'local', type: 'stdio', command: 'echo', args: ['hi'], enabled: true, stateless: true,
    });
    (client as unknown as { serverStates: Map<string, unknown> }).serverStates.set('local', {
      config: { name: 'local', type: 'stdio', command: 'echo', args: ['hi'], enabled: true, stateless: true },
      status: 'connected', toolCount: 0, resourceCount: 0,
    });
    (client as unknown as { idleReaper: { lastUsedAt: Map<string, number> } }).idleReaper.lastUsedAt.set('local', 0);

    now = 200;
    // Well past the ttl but far short of the default scan cadence: a 0 that fell through
    // to a 1ms interval would already have reaped many times over by here.
    await vi.advanceTimersByTimeAsync(200);
    expect(sdkClient.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(MCP_TIMEOUTS.IDLE_REAP_SCAN);
    expect(sdkClient.close).toHaveBeenCalledOnce();
  });

  it('ends readResource promptly with an abort error instead of blocking on a hung lazy-connect', async () => {
    const client = new MCPClient({});
    const controller = new AbortController();
    // Models a lazy-connect that never settles on its own within this test — only the
    // caller's abort resolves it — so a prompt rejection proves the signal was raced,
    // not that ensureConnected happened to return quickly.
    const ensureConnected = vi.spyOn(client, 'ensureConnected').mockImplementation((_serverName, signal) => new Promise((resolve) => {
      if (signal?.aborted) { resolve(false); return; }
      signal?.addEventListener('abort', () => resolve(false), { once: true });
    }));

    const promise = client.readResource('local', 'mcp://resource', controller.signal);
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(ensureConnected).toHaveBeenCalledWith('local', controller.signal);
  });

  it('ends getPrompt promptly with an abort error instead of blocking on a hung lazy-connect', async () => {
    const client = new MCPClient({});
    const controller = new AbortController();
    const ensureConnected = vi.spyOn(client, 'ensureConnected').mockImplementation((_serverName, signal) => new Promise((resolve) => {
      if (signal?.aborted) { resolve(false); return; }
      signal?.addEventListener('abort', () => resolve(false), { once: true });
    }));

    const promise = client.getPrompt('local', 'prompt', undefined, controller.signal);
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(ensureConnected).toHaveBeenCalledWith('local', controller.signal);
  });

  it('does not reap an unmarked stdio server when stateless is absent', async () => {
    let now = 0;
    const client = new MCPClient({ idleReaping: { enabled: true, ttlMs: 100, scanIntervalMs: 25 }, now: () => now });
    const sdkClient = { close: vi.fn(async () => {}) };
    const config = { name: 'local', type: 'stdio' as const, command: 'echo', args: ['hi'], enabled: true };
    (client as unknown as { clients: Map<string, unknown> }).clients.set('local', sdkClient);
    (client as unknown as { serverConfigs: Map<string, unknown> }).serverConfigs.set('local', config);
    (client as unknown as { serverStates: Map<string, unknown> }).serverStates.set('local', {
      config, status: 'connected', toolCount: 0, resourceCount: 0,
    });
    (client as unknown as { idleReaper: { lastUsedAt: Map<string, number> } }).idleReaper.lastUsedAt.set('local', 0);

    now = 500;
    await vi.advanceTimersByTimeAsync(500);
    expect(sdkClient.close).not.toHaveBeenCalled();
    expect(client.isConnected('local')).toBe(true);
  });

  it('reaps a stateless stdio server after the idle ttl', async () => {
    let now = 0;
    const { client, sdkClient } = connectedClient(() => now);
    now = 100;
    await vi.advanceTimersByTimeAsync(25);
    expect(sdkClient.close).toHaveBeenCalledOnce();
    expect(client.isConnected('local')).toBe(false);
    expect(client.getServerStates().find((state) => state.config.name === 'local')?.status).toBe('lazy');
  });

  it('puts the restart notice on the first tool result after a reap and not the second', async () => {
    let now = 0;
    const { client, sdkClient } = connectedClient(() => now);
    const fresh = {
      callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'pong' }] })),
      close: vi.fn(async () => {}),
    };
    vi.spyOn(client, 'connect').mockImplementation(async (config) => {
      (client as unknown as { clients: Map<string, unknown> }).clients.set(config.name, fresh);
      const state = (client as unknown as { serverStates: Map<string, { status: string }> }).serverStates.get(config.name);
      if (state) state.status = 'connected';
      (client as unknown as { bumpServerConnectionGeneration: (name: string, rememberBirth?: boolean) => void })
        .bumpServerConnectionGeneration(config.name, true);
    });

    now = 100;
    await vi.advanceTimersByTimeAsync(25);
    expect(sdkClient.close).toHaveBeenCalledOnce();

    const notice = 'MCP server local was restarted after idle; prior session state is gone';
    const first = await client.callTool('c1', 'local', 'ping', {});
    expect(first.output).toContain(notice);
    expect(first.output).toContain('pong');

    const second = await client.callTool('c2', 'local', 'ping', {});
    expect(second.output).toBe('pong');
    expect(second.output).not.toContain('was restarted after idle');
  });

  it('does not attach a restart notice on a first-ever connect', async () => {
    const client = new MCPClient({
      idleReaping: { enabled: true, ttlMs: 100_000, scanIntervalMs: 60_000 },
      now: () => 0,
    });
    const fresh = {
      callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'pong' }] })),
      close: vi.fn(async () => {}),
    };
    vi.spyOn(client, 'connect').mockImplementation(async (config) => {
      (client as unknown as { clients: Map<string, unknown> }).clients.set(config.name, fresh);
      const state = (client as unknown as { serverStates: Map<string, { status: string }> }).serverStates.get(config.name);
      if (state) state.status = 'connected';
      (client as unknown as { bumpServerConnectionGeneration: (name: string, rememberBirth?: boolean) => void })
        .bumpServerConnectionGeneration(config.name, true);
    });
    client.addServer({
      name: 'local', type: 'stdio', command: 'echo', args: ['hi'], enabled: true, stateless: true,
    });

    const result = await client.callTool('c1', 'local', 'ping', {});
    expect(result.output).toBe('pong');
    expect(result.output).not.toContain('was restarted after idle');
    expect(fresh.callTool).toHaveBeenCalledOnce();
  });

  it('does not use a closing client when its generation was already bumped and reconnects once', async () => {
    const now = 0;
    const { client } = connectedClient(() => now);
    const closing = {
      callTool: vi.fn(async () => { throw new Error('closed client used'); }),
      close: vi.fn(async () => {}),
    };
    (client as unknown as { clients: Map<string, unknown> }).clients.set('local', closing);
    const generations = (client as unknown as { serverConnectionGenerations: Map<string, number> }).serverConnectionGenerations;
    const births = (client as unknown as { clientBirthGeneration: Map<string, number> }).clientBirthGeneration;
    // disconnect() increments the generation before close() finishes, while this client is still mapped.
    generations.set('local', 2);
    births.set('local', 1);

    const fresh = {
      callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'fresh' }] })),
      close: vi.fn(async () => {}),
    };
    const connect = vi.spyOn(client, 'connect').mockImplementation(async (config) => {
      (client as unknown as { clients: Map<string, unknown> }).clients.set(config.name, fresh);
      const state = (client as unknown as { serverStates: Map<string, { status: string }> }).serverStates.get(config.name);
      if (state) state.status = 'connected';
      (client as unknown as { bumpServerConnectionGeneration: (name: string, rememberBirth?: boolean) => void })
        .bumpServerConnectionGeneration(config.name, true);
    });

    const result = await client.callTool('c1', 'local', 'ping', {});
    expect(closing.callTool).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledOnce();
    expect(fresh.callTool).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
    expect(result.output).toContain('fresh');
  });

  it('does not let a mid-reap tool call lose the replacement stdio connection', async () => {
    let now = 0;
    const { client, sdkClient } = connectedClient(() => now);
    const transports = (client as unknown as {
      transports: Map<string, { pid?: number; close: () => Promise<void> }>;
    }).transports;
    const oldTransport = { pid: 111, close: vi.fn(async () => {}) };
    transports.set('local', oldTransport);
    const registry = (client as unknown as { registry: MCPToolRegistry }).registry;
    registry.tools.push({
      serverName: 'local', name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} },
    });
    const generations = (client as unknown as { serverConnectionGenerations: Map<string, number> }).serverConnectionGenerations;
    const births = (client as unknown as { clientBirthGeneration: Map<string, number> }).clientBirthGeneration;
    generations.set('local', 1);
    births.set('local', 1);

    const closingCall = vi.fn(async () => {
      throw new Error('closed client used');
    });
    Object.assign(sdkClient, { callTool: closingCall });
    let closeFinished = false;
    let releaseClose: () => void = () => {};
    sdkClient.close.mockImplementation(() => new Promise<void>((resolve) => {
      releaseClose = () => {
        closeFinished = true;
        resolve();
      };
    }));

    const fresh = {
      callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'pong' }] })),
      close: vi.fn(async () => {}),
    };
    const newTransport = { pid: 4242, close: vi.fn(async () => {}) };
    let connectStartedBeforeClose = false;
    const connect = vi.spyOn(client, 'connect').mockImplementation(async (config) => {
      connectStartedBeforeClose = !closeFinished;
      (client as unknown as { clients: Map<string, unknown> }).clients.set(config.name, fresh);
      transports.set(config.name, newTransport);
      registry.tools = [{
        serverName: 'local', name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} },
      }];
      const state = (client as unknown as { serverStates: Map<string, { status: string; toolCount: number }> }).serverStates.get(config.name);
      if (state) {
        state.status = 'connected';
        state.toolCount = 1;
      }
      (client as unknown as { bumpServerConnectionGeneration: (name: string, rememberBirth?: boolean) => void })
        .bumpServerConnectionGeneration(config.name, true);
    });

    now = 100;
    const reapSettled = (client as unknown as {
      idleReaper: { reapIdleConnections: () => Promise<void> };
    }).idleReaper.reapIdleConnections();
    const toolSettled = client.callTool('c-race', 'local', 'ping', {});
    await Promise.resolve();
    releaseClose();
    const result = await toolSettled;
    await reapSettled;

    expect(result.success).toBe(true);
    expect(closingCall).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledOnce();
    expect(fresh.callTool).toHaveBeenCalledOnce();
    expect(oldTransport.close).toHaveBeenCalledOnce();
    expect({
      connectStartedBeforeClose,
      status: client.getServerState('local')?.status,
      pids: client.getStdioChildPids(),
      transportCount: transports.size,
      sameTransport: transports.get('local') === newTransport,
      toolResolvable: client.getToolDefinitions().some((tool) => tool.name === 'mcp__local__ping'),
    }).toEqual({
      connectStartedBeforeClose: false,
      status: 'connected',
      pids: [4242],
      transportCount: 1,
      sameTransport: true,
      toolResolvable: true,
    });
  });
});
