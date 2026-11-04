import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { Server } from '@modelcontextprotocol/server';
import { MCP_TIMEOUTS } from '../../../src/shared/constants';
import { setBrowserWindowInteractionProbe } from '../../../src/host/platform/windowBridge';
import { MCPToolRegistry } from '../../../src/host/mcp/mcpToolRegistry';

const LEGACY_PROTOCOL_VERSION = '2025-11-25';
const SERVER_NAME = 'progress-transport-fixture';

const clients: Client[] = [];
const servers: Server[] = [];

interface ProgressFixtureOptions {
  /** 两次进度通知的间隔（假时钟毫秒） */
  intervalMs: number;
  /** 发满该跳数后返回结果；不传 = 永远报进度、永不返回 */
  completeAfterTicks?: number;
}

/**
 * 真 SDK Client/Server over InMemoryTransport 的进度夹具：
 * 工作时长由假时钟 tick 驱动（与是否带 token 无关，对齐真实慢连接器），
 * 客户端带了 onprogress（SDK 自动注入 progressToken）时每 intervalMs 报一次进度，
 * 没带 token 时按静默连接器处理（照样干活、不发通知）。
 */
function registerProgressTool(server: Server, toolName: string, opts: ProgressFixtureOptions): void {
  server.setRequestHandler('tools/call', async (request, context) => {
    const progressToken = (request.params as { _meta?: { progressToken?: number | string } })._meta?.progressToken;
    let ticks = 0;
    await new Promise<void>((resolve) => {
      const tick = async () => {
        ticks += 1;
        if (opts.completeAfterTicks !== undefined && ticks >= opts.completeAfterTicks) {
          resolve();
          return;
        }
        if (progressToken !== undefined) {
          try {
            await context.mcpReq.notify({
              method: 'notifications/progress',
              params: { progressToken, progress: ticks, total: opts.completeAfterTicks ?? 0 },
            });
          } catch {
            // 客户端超时/取消后 transport 半关：停止报进度
            resolve();
            return;
          }
        }
        setTimeout(tick, opts.intervalMs);
      };
      setTimeout(tick, opts.intervalMs);
    });
    return {
      content: [{ type: 'text', text: `export done after ${ticks} ticks` }],
    };
  });
}

async function createProgressTransport(opts: ProgressFixtureOptions): Promise<{ client: Client; registry: MCPToolRegistry }> {
  const client = new Client(
    { name: 'progress-renewal-test', version: '1.0.0' },
    { supportedProtocolVersions: [LEGACY_PROTOCOL_VERSION] },
  );
  const server = new Server(
    { name: SERVER_NAME, version: '1.0.0' },
    { capabilities: { tools: {} }, supportedProtocolVersions: [LEGACY_PROTOCOL_VERSION] },
  );
  clients.push(client);
  servers.push(server);

  registerProgressTool(server, 'export_sheet', opts);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, registry: new MCPToolRegistry() };
}

/** 永不返回也永不报进度的静默工具 */
function registerSilentTool(server: Server): void {
  server.setRequestHandler('tools/call', () => new Promise(() => {}));
}

async function createSilentTransport(): Promise<{ client: Client; registry: MCPToolRegistry }> {
  const client = new Client(
    { name: 'silent-server-test', version: '1.0.0' },
    { supportedProtocolVersions: [LEGACY_PROTOCOL_VERSION] },
  );
  const server = new Server(
    { name: SERVER_NAME, version: '1.0.0' },
    { capabilities: { tools: {} }, supportedProtocolVersions: [LEGACY_PROTOCOL_VERSION] },
  );
  clients.push(client);
  servers.push(server);
  registerSilentTool(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, registry: new MCPToolRegistry() };
}

beforeEach(() => {
  vi.useRealTimers();
  setBrowserWindowInteractionProbe(() => false);
});

afterEach(async () => {
  vi.useRealTimers();
  setBrowserWindowInteractionProbe(null);
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
});

describe('MCP tool call budget（CALL_TOOL 120s + 进度续期）', () => {
  it('静默连接器在默认预算（MCP_TIMEOUTS.CALL_TOOL = 120s）被杀，60 秒不再掐', async () => {
    expect(MCP_TIMEOUTS.CALL_TOOL).toBe(120_000);
    expect(MCP_TIMEOUTS.CALL_TOOL_MAX_TOTAL).toBe(600_000);
    const { client, registry } = await createSilentTransport();
    vi.useFakeTimers();

    const result = registry.callExternalTool('tool-silent', SERVER_NAME, 'export_sheet', {}, client);
    const rejection = expect(result).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
      message: 'Request timed out',
    });

    await vi.advanceTimersByTimeAsync(60_000);
    const marker = Symbol('pending');
    await expect(Promise.race([result, Promise.resolve(marker)])).resolves.toBe(marker);
    await vi.advanceTimersByTimeAsync(MCP_TIMEOUTS.CALL_TOOL - 60_000);
    await rejection;
  });

  it('连接器持续报进度时预算被续期：60 秒预算下跑满 90 秒仍拿到结果', async () => {
    const { client, registry } = await createProgressTransport({ intervalMs: 10_000, completeAfterTicks: 9 });
    vi.useFakeTimers();

    const result = registry.callExternalTool(
      'tool-progress',
      SERVER_NAME,
      'export_sheet',
      {},
      client,
      { timeoutMs: 60_000 },
    );

    await vi.advanceTimersByTimeAsync(90_000);
    await expect(result).resolves.toMatchObject({
      success: true,
      output: 'export done after 9 ticks',
    });
  });

  it('进度续期不能越过 CALL_TOOL_MAX_TOTAL（10 分钟）总上限', async () => {
    const { client, registry } = await createProgressTransport({ intervalMs: 10_000 });
    vi.useFakeTimers();

    const result = registry.callExternalTool(
      'tool-cap',
      SERVER_NAME,
      'export_sheet',
      {},
      client,
      { timeoutMs: 60_000 },
    );
    const rejection = expect(result).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
      message: 'Request timed out',
    });

    await vi.advanceTimersByTimeAsync(MCP_TIMEOUTS.CALL_TOOL_MAX_TOTAL - 1_000);
    const marker = Symbol('pending');
    await expect(Promise.race([result, Promise.resolve(marker)])).resolves.toBe(marker);
    await vi.advanceTimersByTimeAsync(2_000);
    await rejection;
  });
});
