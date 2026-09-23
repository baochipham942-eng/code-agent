// ============================================================================
// discoverLazyServersForSearch 的取消语义（N-MCP-LAZYCONNECT-SIGNAL ③）
// ============================================================================
//
// 不变量：ToolSearch 链路把调用方的 abortSignal 端到端传进懒发现循环——
//   1. 某个 server 的懒连接等待被 abort 打断时，已得结果照常返回，后续 server
//      不再拉起（ensureConnected 调用次数为 0）。
//   2. 未取消的连接失败行为不变：仍逐个尝试、逐个记 connected:false。
//
// 走 Object.create(MCPClient.prototype) 的真 thin delegate
// discoverLazyServersForSearch，顺带钉住 delegate 的 signal 透传。

import { describe, expect, it, vi } from 'vitest';
import { MCPClient } from '../../../src/host/mcp/mcpClient';

type DiscoverEntry = {
  serverName: string;
  connected: boolean;
  toolCount: number;
  error?: string;
};

type TestableDiscoverClient = {
  serverConfigs: Map<string, unknown>;
  serverStates: Map<string, { status: string; error?: string }>;
  registry: { getToolCount(serverName: string): number };
  ensureConnected(serverName: string, signal?: AbortSignal): Promise<boolean>;
  discoverLazyServersForSearch(query: string, allowlist?: string[], signal?: AbortSignal): Promise<DiscoverEntry[]>;
};

function makeDiscoverClient(serverNames: string[]): TestableDiscoverClient {
  const client = Object.create(MCPClient.prototype) as TestableDiscoverClient;
  client.serverConfigs = new Map(serverNames.map((name) => [
    name,
    { name, command: `cmd-${name}`, args: [], enabled: true, lazyLoad: true },
  ]));
  client.serverStates = new Map(serverNames.map((name) => [name, { status: 'lazy' }]));
  client.registry = { getToolCount: () => 0 };
  return client;
}

describe('discoverLazyServersForSearch 取消语义（N-MCP-LAZYCONNECT-SIGNAL ③）', () => {
  it('等待被 abort 打断：立即返回已得结果，后续 server 不再拉起', async () => {
    const client = makeDiscoverClient(['alpha', 'beta']);
    const ensureBeta = vi.fn().mockResolvedValue(true);
    client.ensureConnected = vi.fn((serverName: string, signal?: AbortSignal) => {
      if (serverName !== 'alpha') return ensureBeta(serverName, signal);
      // 桩：挂住直到收到的 signal 被 abort 才返回 false
      return new Promise<boolean>((resolve) => {
        signal?.addEventListener('abort', () => resolve(false), { once: true });
      });
    });

    const controller = new AbortController();
    const pending = client.discoverLazyServersForSearch('alpha beta', undefined, controller.signal);
    setTimeout(() => controller.abort(), 20);

    const startedAt = Date.now();
    const results = await pending;
    expect(Date.now() - startedAt).toBeLessThan(200); // 立即返回，不阻塞到下一个连接超时
    expect(results).toEqual([
      { serverName: 'alpha', connected: false, toolCount: 0 },
    ]);
    expect(ensureBeta).not.toHaveBeenCalled(); // 取消后不再拉起后续 server
  });

  it('未取消的连接失败行为不变：仍逐个尝试、逐个记 connected:false', async () => {
    const client = makeDiscoverClient(['alpha', 'beta']);
    const ensureConnected = vi.fn().mockResolvedValue(false);
    client.ensureConnected = ensureConnected;

    const results = await client.discoverLazyServersForSearch('alpha beta');

    expect(results).toEqual([
      { serverName: 'alpha', connected: false, toolCount: 0 },
      { serverName: 'beta', connected: false, toolCount: 0 },
    ]);
    expect(ensureConnected).toHaveBeenCalledTimes(2);
  });
});
