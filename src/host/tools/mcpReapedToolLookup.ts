import type { ToolDefinition } from '../../shared/contract';
import { getMCPClient } from '../mcp';

/**
 * After an idle reap the registry drops MCP tool definitions, so ToolExecutor
 * would report Unknown tool before callTool can lazy-reconnect. Reconnect a
 * server that is lazy because it was reaped, then resolve the name again.
 */
export async function lookupMcpToolAfterReapedReconnect(
  toolName: string,
  lookup: (name: string) => ToolDefinition | undefined,
): Promise<ToolDefinition | undefined> {
  const client = getMCPClient();
  const parsed = client.parseMCPToolName(toolName);
  if (!parsed) return undefined;
  const status = client.getServerState(parsed.serverName)?.status;
  if (status !== 'lazy' || !client.wasServerReaped(parsed.serverName)) return undefined;
  if (!await client.ensureConnected(parsed.serverName)) return undefined;
  return lookup(toolName);
}
