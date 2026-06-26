// ============================================================================
// MCP listChanged 集成测试（G25 Item 1）
//
// 真实链路：MCPClient.connect → 真实 stdio 子进程 → 真实 MCP 协议 →
//   server 运行时新增工具发 notifications/tools/list_changed →
//   SDK Client listChanged handler → MCPToolRegistry 刷新 → capabilities-changed 事件
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import { MCPClient, type MCPCapabilitiesChangedEvent } from '../../../src/host/mcp/mcpClient';
import { resetToolSearchService, getToolSearchService } from '../../../src/host/services/toolSearch';

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

const FIXTURE = path.resolve(__dirname, '../../fixtures/mcp/list-changed-server.mjs');

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('MCP listChanged notification handling', () => {
  let client: MCPClient | undefined;

  afterEach(async () => {
    if (client) {
      await client.disconnectAll();
      client = undefined;
    }
  });

  it('refreshes registry + ToolSearch + emits event when server adds a tool at runtime', async () => {
    resetToolSearchService();
    client = new MCPClient();

    const config = {
      name: 'fixture',
      type: 'stdio' as const,
      command: 'node',
      args: [FIXTURE],
      enabled: true,
      lazyLoad: false,
    };
    client.addServer(config);

    const events: MCPCapabilitiesChangedEvent[] = [];
    client.on('capabilities-changed', (e: MCPCapabilitiesChangedEvent) => events.push(e));

    await client.connect(config);

    // 初始状态：ping + add_dynamic_tool，没有 dynamic_tool
    const initialNames = client
      .getToolDefinitions()
      .map((d) => d.name)
      .filter((n) => n.startsWith('mcp__fixture__'));
    expect(initialNames.sort()).toEqual(['mcp__fixture__add_dynamic_tool', 'mcp__fixture__ping']);
    expect(client.getServerState('fixture')?.toolCount).toBe(2);

    // 触发 server 运行时新增工具
    const callResult = await client.callTool('call-1', 'fixture', 'add_dynamic_tool', {});
    expect(callResult.success).toBe(true);

    // 等待 listChanged 通知传播（SDK 默认 debounce 300ms + autoRefresh 重新拉取）
    await waitFor(() =>
      client!.getToolDefinitions().some((d) => d.name === 'mcp__fixture__dynamic_tool'),
    );

    // registry 已刷新
    const afterNames = client
      .getToolDefinitions()
      .map((d) => d.name)
      .filter((n) => n.startsWith('mcp__fixture__'));
    expect(afterNames.sort()).toEqual([
      'mcp__fixture__add_dynamic_tool',
      'mcp__fixture__dynamic_tool',
      'mcp__fixture__ping',
    ]);

    // serverState.toolCount 已同步
    expect(client.getServerState('fixture')?.toolCount).toBe(3);

    // ToolSearchService 已同步（新工具可被搜索发现）
    const searchable = getToolSearchService()
      .getDeferredToolsSummary()
      .split('\n')
      .filter((n) => n.startsWith('mcp__fixture__'));
    expect(searchable).toContain('mcp__fixture__dynamic_tool');

    // capabilities-changed 事件已 emit
    const toolsEvent = events.find((e) => e.kind === 'tools');
    expect(toolsEvent).toBeDefined();
    expect(toolsEvent?.serverName).toBe('fixture');
    expect(toolsEvent?.count).toBe(3);
  }, 20000);
});
