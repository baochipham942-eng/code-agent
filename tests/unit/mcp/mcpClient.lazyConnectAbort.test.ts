// ============================================================================
// MCPClient.callTool 懒加载路径的取消语义（N-MCP-LAZYCONNECT-SIGNAL ①）
// ============================================================================
//
// 不变量：callTool 触发懒连接时把调用方的 abortSignal 传进 ensureConnected——
// 用户取消工具调用后，懒连接等待立即被打断，按既有取消形状（error 'cancelled' +
// metadata.cancelledByRun）返回，而不是阻塞到连接超时、也不说成 connection failed。
//
// 桩法：ensureConnected 桩成「挂住直到收到的 signal 被 abort 才返回 false」，
// 行为锚在「abort 后立即返回」而非桩的调用形状。

import { describe, expect, it, vi } from 'vitest';
import { MCPClient } from '../../../src/host/mcp/mcpClient';

describe('MCPClient.callTool 懒加载路径的取消语义（N-MCP-LAZYCONNECT-SIGNAL ①）', () => {
  it('懒连接等待被 abort 打断时立即按取消形状返回，不说成 connection failed', async () => {
    const mcpClient = new MCPClient();
    const serverName = 'lazy-server';
    (mcpClient as unknown as { serverStates: Map<string, { status: string }> }).serverStates
      .set(serverName, { status: 'lazy' });

    vi.spyOn(mcpClient, 'ensureConnected').mockImplementation(
      async (_serverName: string, signal?: AbortSignal) =>
        new Promise<boolean>((resolve) => {
          signal?.addEventListener('abort', () => resolve(false), { once: true });
        }),
    );

    const controller = new AbortController();
    const pending = mcpClient.callTool('call-1', serverName, 'some_tool', {}, { abortSignal: controller.signal });
    setTimeout(() => controller.abort(), 20);

    const startedAt = Date.now();
    const result = await pending;
    expect(Date.now() - startedAt).toBeLessThan(200); // 立即返回，不阻塞到连接超时
    expect(result).toEqual({
      toolCallId: 'call-1',
      success: false,
      error: 'cancelled',
      metadata: { cancelledByRun: true },
    });
  });

  it('未取消的懒连接失败仍按 connection failed 报错（行为不变）', async () => {
    const mcpClient = new MCPClient();
    const serverName = 'lazy-server';
    (mcpClient as unknown as { serverStates: Map<string, { status: string; error?: string }> }).serverStates
      .set(serverName, { status: 'lazy' });

    vi.spyOn(mcpClient, 'ensureConnected').mockResolvedValue(false);

    const result = await mcpClient.callTool('call-2', serverName, 'some_tool', {});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('connection failed');
      expect(result.error).not.toContain('cancelled');
    }
  });
});
