// ============================================================================
// MCPClient.ensureConnected 取消语义（N-SUBAGENT-ZEROTOOLS 返修 Important 1）
// ============================================================================
//
// 不变量：
//   1. signal 只中断「本次等待」：等待方被取消时立即按未连上返回，但底层共享连接
//      继续建立、建成后注册进共享注册表——其他等待者 / 后续调用照常取到。
//   2. signal 已 aborted 时不发起连接。
//
// 用 Object.create(MCPClient.prototype) + 注入私有字段构造受控实例，ensureConnected
// 走真实现，connect 用 spy 控制（挂起 / 成功回填 clients）。
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import { MCPClient } from '../../../src/host/mcp/mcpClient';

/**
 * 受控测试客户端：Object.create(MCPClient.prototype) 保留真 ensureConnected，
 * 私有字段经类型断言注入。不能写成 `MCPClient & {...}` 交叉——private 字段在
 * 交叉类型里会把成员推断成 never。
 */
type TestableMCPClient = {
  clients: Map<string, unknown>;
  inProcessServers: Map<string, unknown>;
  serverConfigs: Map<string, unknown>;
  serverStates: Map<string, { status: string }>;
  connectingServers: Map<string, Promise<void>>;
  connect(config: { name: string }): Promise<void>;
  ensureConnected(serverName: string, signal?: AbortSignal): Promise<boolean>;
};

function makeTestableClient(serverName: string): TestableMCPClient {
  const client = Object.create(MCPClient.prototype) as TestableMCPClient;
  Object.assign(client, {
    clients: new Map(),
    inProcessServers: new Map(),
    serverConfigs: new Map([
      [serverName, { name: serverName, command: 'sleep', args: ['60'], enabled: true, lazyLoad: true }],
    ]),
    serverStates: new Map([[serverName, { status: 'lazy' }]]),
    connectingServers: new Map(),
  });
  return client;
}

describe('MCPClient.ensureConnected 取消语义（N-SUBAGENT-ZEROTOOLS 返修 Important 1）', () => {
  it('signal 只中断本次等待：等待方取消后，共享连接继续建立并注册，其他等待者照常取到', async () => {
    const client = makeTestableClient('shared');
    let releaseConnect!: () => void;
    const connectGate = new Promise<void>((resolve) => { releaseConnect = resolve; });
    const connectSpy = vi.spyOn(client, 'connect').mockImplementation(async (config: { name: string }) => {
      await connectGate;
      client.clients.set(config.name, { fake: true });
    });

    const callerAController = new AbortController();
    // A 先发起懒加载连接（等待可被自己的 signal 中断）
    const callerA = client.ensureConnected('shared', callerAController.signal);
    expect(client.connectingServers.size).toBe(1);
    // B 搭同一条共享连接（无 signal）
    const callerB = client.ensureConnected('shared');

    callerAController.abort('subagent-cancelled');
    await expect(callerA).resolves.toBe(false); // A 的等待立即中断

    releaseConnect(); // 底层连接此刻才完成
    await expect(callerB).resolves.toBe(true); // B 等到了共享连接
    expect(client.clients.has('shared')).toBe(true); // 连接保留注册，后续可复用
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it('signal 已 aborted 时不发起连接', async () => {
    const client = makeTestableClient('idle');
    const connectSpy = vi.spyOn(client, 'connect').mockImplementation(async () => {});
    const controller = new AbortController();
    controller.abort();

    await expect(client.ensureConnected('idle', controller.signal)).resolves.toBe(false);
    expect(connectSpy).not.toHaveBeenCalled();
  });
});
