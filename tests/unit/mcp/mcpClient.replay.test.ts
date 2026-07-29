import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { MCPClient } from '../../../src/host/mcp/mcpClient';
import { MCPToolRegistry } from '../../../src/host/mcp/mcpToolRegistry';
import { MCP_TOOL_DELIVERY_UNKNOWN_CODE } from '../../../src/host/mcp/mcpErrors';
import type { MCPToolAnnotations } from '../../../src/host/mcp/types';

function setupInterruptedCall(annotations?: MCPToolAnnotations) {
  const mcpClient = new MCPClient();
  const registry = (mcpClient as unknown as { registry: MCPToolRegistry }).registry;
  const clients = (mcpClient as unknown as { clients: Map<string, unknown> }).clients;
  const sdkClient = {};
  clients.set('remote', sdkClient);
  registry.tools.push({
    name: 'mutate',
    description: 'test tool',
    inputSchema: { type: 'object' },
    serverName: 'remote',
    ...(annotations ? { annotations } : {}),
  });

  vi.spyOn(registry, 'callExternalTool').mockRejectedValue(
    new SdkError(SdkErrorCode.ConnectionClosed, 'connection closed during call'),
  );
  const retryResult = {
    toolCallId: 'call-1',
    success: true,
    output: 'replayed',
  };
  const retrySpy = vi.spyOn(registry, 'retryToolCall').mockResolvedValue(retryResult);
  vi.spyOn(mcpClient, 'reconnect').mockResolvedValue({ success: true });
  return { mcpClient, retrySpy, retryResult };
}

describe('MCPClient interrupted tools/call replay policy', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fails closed for an unannotated tool and exposes unknown delivery status', async () => {
    const { mcpClient, retrySpy } = setupInterruptedCall();

    await expect(mcpClient.callTool('call-1', 'remote', 'mutate', {})).rejects.toMatchObject({
      code: MCP_TOOL_DELIVERY_UNKNOWN_CODE,
      deliveryStatus: 'unknown',
      serverName: 'remote',
      toolName: 'mutate',
    });
    expect(retrySpy).not.toHaveBeenCalled();
  });

  it.each([
    ['read-only', { readOnlyHint: true }],
    ['idempotent', { idempotentHint: true }],
  ] as const)('replays an explicitly %s tool after reconnect', async (_label, annotations) => {
    const { mcpClient, retrySpy, retryResult } = setupInterruptedCall(annotations);

    await expect(mcpClient.callTool('call-1', 'remote', 'mutate', {})).resolves.toEqual(retryResult);
    expect(retrySpy).toHaveBeenCalledOnce();
  });

  it('never replays a destructive tool even if it also claims idempotency', async () => {
    const { mcpClient, retrySpy } = setupInterruptedCall({
      destructiveHint: true,
      idempotentHint: true,
    });

    await expect(mcpClient.callTool('call-1', 'remote', 'mutate', {})).rejects.toMatchObject({
      code: MCP_TOOL_DELIVERY_UNKNOWN_CODE,
    });
    expect(retrySpy).not.toHaveBeenCalled();
  });
});
