import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  Client,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { MCPClient } from '../../../src/host/mcp/mcpClient';

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: loggerMocks,
  createLogger: () => loggerMocks,
}));

const MODERN_PROTOCOL_VERSION = '2026-07-28';
const LEGACY_PROTOCOL_VERSION = '2025-11-25';
const MODERN_FIXTURE = path.resolve(__dirname, '../../fixtures/mcp/protocol-modern-server.mjs');
const LEGACY_FIXTURE = path.resolve(__dirname, '../../fixtures/mcp/protocol-legacy-server.mjs');
const CODE_AGENT_ENTRY = path.resolve(__dirname, '../../../src/host/mcp/mcp-server-entry.ts');

type FixtureEvent = {
  pid: number;
  direction?: 'in' | 'out';
  handler?: string;
  lifecycle?: string;
  params?: Record<string, unknown>;
  message?: {
    id?: string | number;
    method?: string;
    params?: Record<string, unknown>;
    result?: Record<string, unknown>;
  };
};

function fixtureConfig(name: string, fixture: string, eventLog: string) {
  return {
    name,
    type: 'stdio' as const,
    command: process.execPath,
    args: [fixture],
    env: { MCP_FIXTURE_EVENT_LOG: eventLog },
    enabled: true,
    lazyLoad: false,
  };
}

function processEnvironment(overrides: Record<string, string>): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    ...overrides,
  };
}

function incoming(events: FixtureEvent[], method: string): FixtureEvent[] {
  return events.filter((event) => event.direction === 'in' && event.message?.method === method);
}

function responseFor(events: FixtureEvent[], request: FixtureEvent): FixtureEvent | undefined {
  return events.find((event) =>
    event.direction === 'out'
    && event.pid === request.pid
    && event.message?.id === request.message?.id,
  );
}

async function readEvents(eventLog: string): Promise<FixtureEvent[]> {
  const content = await readFile(eventLog, 'utf8');
  return content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as FixtureEvent);
}

describe('MCP dual protocol compatibility', () => {
  const clients: MCPClient[] = [];
  const sdkClients: Client[] = [];
  const tempDirectories: string[] = [];

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.disconnectAll()));
    await Promise.allSettled(sdkClients.splice(0).map((client) => client.close()));
    await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function runNeoClientAgainstFixture(
    name: string,
    fixture: string,
    expectedOutput: string,
  ): Promise<FixtureEvent[]> {
    const directory = await mkdtemp(path.join(tmpdir(), `neo-mcp-${name}-`));
    tempDirectories.push(directory);
    const eventLog = path.join(directory, 'events.ndjson');
    const client = new MCPClient();
    clients.push(client);
    const config = fixtureConfig(name, fixture, eventLog);
    client.addServer(config);

    await client.connect(config);
    expect(client.getServerState(name)).toMatchObject({ status: 'connected', toolCount: 1 });
    expect(client.getToolDefinitions().map((tool) => tool.name)).toContain(`mcp__${name}__echo`);

    const result = await client.callTool(`call-${name}`, name, 'echo', { value: 'fixture' });
    expect(result).toMatchObject({ success: true, output: expectedOutput });

    await client.disconnectAll();
    clients.splice(clients.indexOf(client), 1);
    return readEvents(eventLog);
  }

  it('uses the modern no-handshake path and sends the protocol envelope', async () => {
    const events = await runNeoClientAgainstFixture('modern', MODERN_FIXTURE, 'modern:fixture');

    expect(incoming(events, 'initialize')).toHaveLength(0);
    expect(incoming(events, 'server/discover')).toHaveLength(1);

    for (const method of ['tools/list', 'tools/call']) {
      const request = incoming(events, method).at(-1);
      expect(request, `${method} was not observed`).toBeDefined();
      const meta = request?.message?.params?._meta as Record<string, unknown> | undefined;
      expect(meta).toMatchObject({ [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION });
      expect(meta?.[CLIENT_INFO_META_KEY]).toMatchObject({ name: 'code-agent', version: '0.1.0' });
      expect(meta?.[CLIENT_CAPABILITIES_META_KEY]).toBeDefined();
    }

    const listRequest = incoming(events, 'tools/list').at(-1)!;
    expect(responseFor(events, listRequest)?.message?.result).toMatchObject({
      resultType: 'complete',
      ttlMs: 250,
      cacheScope: 'private',
    });
    const callRequest = incoming(events, 'tools/call').at(-1)!;
    expect(responseFor(events, callRequest)?.message?.result).toMatchObject({ resultType: 'complete' });
  });

  it('falls back to initialize and treats a missing resultType as complete', async () => {
    const events = await runNeoClientAgainstFixture('legacy', LEGACY_FIXTURE, 'legacy:fixture');

    expect(incoming(events, 'server/discover')).toHaveLength(1);
    expect(incoming(events, 'initialize')).toHaveLength(1);
    expect(events.filter((event) => event.lifecycle === 'initialized')).toHaveLength(1);

    const initializeRequest = incoming(events, 'initialize')[0];
    expect(initializeRequest.message?.params).toMatchObject({ protocolVersion: LEGACY_PROTOCOL_VERSION });

    const callRequest = incoming(events, 'tools/call').at(-1)!;
    const wireResult = responseFor(events, callRequest)?.message?.result;
    expect(wireResult).toBeDefined();
    expect(wireResult).not.toHaveProperty('resultType');
  });

  it('serves modern discovery and still accepts a legacy initialize', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'neo-mcp-server-'));
    tempDirectories.push(directory);
    const command = process.execPath;
    const args = ['--import', 'tsx', CODE_AGENT_ENTRY];
    const env = processEnvironment({ CODE_AGENT_DATA_DIR: directory });

    const modernClient = new Client(
      { name: 'modern-gate-client', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } },
    );
    sdkClients.push(modernClient);
    await modernClient.connect(new StdioClientTransport({ command, args, env }));

    expect(modernClient.getProtocolEra()).toBe('modern');
    expect(modernClient.getNegotiatedProtocolVersion()).toBe(MODERN_PROTOCOL_VERSION);
    expect(modernClient.getDiscoverResult()).toMatchObject({
      supportedVersions: [MODERN_PROTOCOL_VERSION],
      capabilities: { resources: {}, tools: {} },
      _meta: {
        [SERVER_INFO_META_KEY]: { name: 'code-agent', version: '1.0.0' },
      },
    });
    await expect(modernClient.listTools()).resolves.toMatchObject({ tools: expect.any(Array) });
    await modernClient.close();
    sdkClients.splice(sdkClients.indexOf(modernClient), 1);

    const legacyClient = new Client(
      { name: 'legacy-gate-client', version: '1.0.0' },
      { versionNegotiation: { mode: 'legacy' } },
    );
    sdkClients.push(legacyClient);
    await legacyClient.connect(new StdioClientTransport({ command, args, env }));

    expect(legacyClient.getProtocolEra()).toBe('legacy');
    expect(legacyClient.getNegotiatedProtocolVersion()).toBe(LEGACY_PROTOCOL_VERSION);
    await expect(legacyClient.listTools()).resolves.toMatchObject({ tools: expect.any(Array) });
  }, 30_000);
});
