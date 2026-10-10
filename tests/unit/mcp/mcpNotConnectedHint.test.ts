// ============================================================================
// MCP server 未连接时的可读 fallback 提示 — N-TOOL-UNAVAILABLE-HINT
// ----------------------------------------------------------------------------
// 不变量：server 掉线时工具结果不只是裸的「not connected」，还带上模型可执行的
// fallback 指引（换工具 / 告知用户服务不可用），避免模型反复重试死服务或谎报
// 「没有这个能力」。两个入口共用 mcpReapPolicy.notConnected() 同一构建器：
//   1. acquireMcpToolClient 直接走 notConnected 分支；
//   2. MCPClient.callTool 整链路（registry 参数规整 / telemetry / idle reaper
//      均为受控注入）server 掉线时透出同一条提示。
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import { MCPClient } from '../../../src/host/mcp/mcpClient';
import {
  acquireMcpToolClient,
  ServerTeardownGate,
} from '../../../src/host/mcp/mcpReapPolicy';
import type { Client } from '@modelcontextprotocol/client';

const NOT_CONNECTED_SNIPPET = 'not connected';
const FALLBACK_SNIPPET = 'Use another available tool, or tell the user this service is unavailable instead of retrying.';

describe('MCP not-connected fallback hint（N-TOOL-UNAVAILABLE-HINT）', () => {
  it('acquireMcpToolClient：server 掉线的结果带 not connected + fallback 指引', async () => {
    const acquired = await acquireMcpToolClient({
      toolCallId: 'tc-1',
      serverName: 'down-server',
      toolName: 'some_tool',
      getClient: () => undefined,
      // 非 lazy / disconnected 状态：不走重连，直接判 not connected
      getStatus: () => 'error',
      getStatusError: () => 'boom',
      getGeneration: () => 0,
      clientBornAt: () => 0,
      ensureConnected: vi.fn(async () => false),
      retireIfCurrent: vi.fn(),
    });

    expect(acquired.client).toBeUndefined();
    expect(acquired.failure).toBeDefined();
    expect(acquired.failure?.success).toBe(false);
    expect(acquired.failure?.toolCallId).toBe('tc-1');
    expect(acquired.failure?.error).toContain(NOT_CONNECTED_SNIPPET);
    expect(acquired.failure?.error).toContain(FALLBACK_SNIPPET);
  });

  it('MCPClient.callTool 整链路：假 server 掉线，工具错误带同一条提示', async () => {
    const client = Object.create(MCPClient.prototype) as unknown as {
      clients: Map<string, Client>;
      inProcessServers: Map<string, unknown>;
      serverStates: Map<string, { status: string }>;
      serverConnectionGenerations: Map<string, number>;
      clientBirthGeneration: Map<string, number>;
      teardownGate: ServerTeardownGate;
      registry: { normalizeToolArgs: (server: string, tool: string, args: Record<string, unknown>) => Record<string, unknown> };
      idleReaper: { applyRestartNotice: (server: string, result: unknown) => unknown; withServerUse: (server: string, fn: () => Promise<unknown>) => Promise<unknown> };
      callTool: (toolCallId: string, serverName: string, toolName: string, args: Record<string, unknown>) => Promise<{ success: boolean; error?: string }>;
    };
    Object.assign(client, {
      clients: new Map(),
      inProcessServers: new Map(),
      serverStates: new Map([['down-server', { status: 'error' }]]),
      serverConnectionGenerations: new Map(),
      clientBirthGeneration: new Map(),
      teardownGate: new ServerTeardownGate(),
      registry: {
        normalizeToolArgs: (_server: string, _tool: string, args: Record<string, unknown>) => args,
      },
      idleReaper: {
        applyRestartNotice: (_server: string, result: unknown) => result,
        withServerUse: (_server: string, fn: () => Promise<unknown>) => fn(),
      },
    });

    const result = await client.callTool('tc-2', 'down-server', 'some_tool', { a: 1 });

    expect(result.success).toBe(false);
    expect(result.error).toContain(NOT_CONNECTED_SNIPPET);
    expect(result.error).toContain(FALLBACK_SNIPPET);
    expect(result.error).toContain('down-server');
  });
});
