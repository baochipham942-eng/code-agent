import type { Client } from '@modelcontextprotocol/client';
import type { ToolResult } from '../../shared/contract';
import { createLogger } from '../services/infra/logger';
import type { MCPServerConfig } from './types';
import { isStdioConfig } from './types';

const logger = createLogger('MCPReapPolicy', { lane: 'mcp' });

/**
 * Idle reaping kills the child process. Only an explicit stateless opt-in
 * may be reaped; omission means the server holds session state.
 */
export function isReapableStdioServer(config: MCPServerConfig | undefined): boolean {
  return !!config
    && isStdioConfig(config)
    && config.lazyLoad !== false
    && config.stateless === true;
}

export function restartNoticeFor(serverName: string): string {
  return `MCP server ${serverName} was restarted after idle; prior session state is gone`;
}

function clientGenerationIsCurrent(
  generationBeforeTake: number | undefined,
  generationNow: number | undefined,
  bornAt: number | undefined,
): boolean {
  if (generationNow !== generationBeforeTake) return false;
  if (bornAt !== undefined && bornAt !== generationNow) return false;
  return true;
}

interface McpToolClientAcquire {
  toolCallId: string;
  serverName: string;
  toolName: string;
  signal?: AbortSignal;
  getClient: () => Client | undefined;
  getStatus: () => string | undefined;
  getStatusError: () => string | undefined;
  getGeneration: () => number | undefined;
  clientBornAt: () => number | undefined;
  ensureConnected: (signal?: AbortSignal) => Promise<boolean>;
  retireIfCurrent: (client: Client) => void;
}

interface AcquiredMcpToolClient {
  client?: Client;
  failure?: ToolResult;
}

function connectionFailed(toolCallId: string, serverName: string, errorMsg: string): ToolResult {
  return {
    toolCallId,
    success: false,
    error: `MCP server ${serverName} connection failed: ${errorMsg}`,
  };
}

function notConnected(toolCallId: string, serverName: string): ToolResult {
  return { toolCallId, success: false, error: `MCP server ${serverName} not connected` };
}

function cancelled(toolCallId: string): ToolResult {
  return {
    toolCallId,
    success: false,
    error: 'cancelled',
    metadata: { cancelledByRun: true },
  };
}

/**
 * Take a client for a tool call. Capture the connection generation before the
 * take, and refuse a client whose generation moved (disconnect already bumped
 * it, or bumped between the take and this check). One ensureConnected retry.
 */
export async function acquireMcpToolClient(input: McpToolClientAcquire): Promise<AcquiredMcpToolClient> {
  const generationBeforeTake = input.getGeneration();
  let client = input.getClient();
  if (!client) {
    const status = input.getStatus();
    if (status === 'lazy' || status === 'disconnected') {
      logger.info(`Server ${input.serverName} not connected, triggering lazy-load for tool: ${input.toolName}`);
      const connected = await input.ensureConnected(input.signal);
      if (!connected) {
        if (input.signal?.aborted) return { failure: cancelled(input.toolCallId) };
        return { failure: connectionFailed(input.toolCallId, input.serverName, input.getStatusError() || 'Failed to connect to server') };
      }
      client = input.getClient();
    }
    if (!client) return { failure: notConnected(input.toolCallId, input.serverName) };
    return { client };
  }

  if (!clientGenerationIsCurrent(generationBeforeTake, input.getGeneration(), input.clientBornAt())) {
    input.retireIfCurrent(client);
    const connected = await input.ensureConnected(input.signal);
    if (!connected) {
      if (input.signal?.aborted) return { failure: cancelled(input.toolCallId) };
      return { failure: connectionFailed(input.toolCallId, input.serverName, input.getStatusError() || 'Failed to connect to server') };
    }
    const replacement = input.getClient();
    if (!replacement) return { failure: notConnected(input.toolCallId, input.serverName) };
    return { client: replacement };
  }
  return { client };
}
