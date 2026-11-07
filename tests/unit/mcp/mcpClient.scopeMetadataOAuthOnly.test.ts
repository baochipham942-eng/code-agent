// 403 / insufficient_scope 的卡片元数据只对 OAuth 连接器写入：非 OAuth 点「重新授权」必败
import { describe, expect, it, vi } from 'vitest';
import { SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/client';
import { MCPClient } from '../../../src/host/mcp/mcpClient';
import type { MCPToolRegistry } from '../../../src/host/mcp/mcpToolRegistry';

async function run(config: Record<string, unknown>) {
  const mcpClient = new MCPClient();
  const registry = (mcpClient as unknown as { registry: MCPToolRegistry }).registry;
  (mcpClient as unknown as { clients: Map<string, unknown> }).clients.set('remote', {});
  registry.tools.push({
    name: 'mutate', description: 't', inputSchema: { type: 'object' }, serverName: 'remote',
    annotations: { readOnlyHint: true },
  });
  vi.spyOn(registry, 'callExternalTool').mockRejectedValue(
    new SdkHttpError(SdkErrorCode.ClientHttpForbidden, 'the server denied access', { status: 403 }),
  );
  vi.spyOn(mcpClient, 'getServerState').mockReturnValue({ config } as never);
  return mcpClient.callTool('call-1', 'remote', 'mutate', {});
}

describe('mcpInsufficientScope metadata is OAuth-only', () => {
  it('writes it for an OAuth http server', async () => {
    const r = await run({ type: 'http-streamable', url: 'https://x.test/mcp', auth: 'oauth' });
    expect(r.metadata).toHaveProperty('mcpInsufficientScope');
  });
  it('omits it for a bearer http server', async () => {
    const r = await run({ type: 'http-streamable', url: 'https://x.test/mcp', auth: 'bearer' });
    expect(r.metadata).toBeUndefined();
  });
  it('omits it for a stdio server', async () => {
    const r = await run({ type: 'stdio', command: 'x' });
    expect(r.metadata).toBeUndefined();
  });
});
