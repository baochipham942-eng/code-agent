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

/**
 * Server-down tool result. The fallback clause is model-facing guidance: without it
 * the model retried the dead server or invented a missing-ability reason.
 * mcpClient.ts reuses this builder for its belt-and-braces guard so the texts cannot drift.
 */
export function notConnected(toolCallId: string, serverName: string): ToolResult {
  return {
    toolCallId,
    success: false,
    error: `MCP server ${serverName} is not connected. Use another available tool, or tell the user this service is unavailable instead of retrying.`,
  };
}

function cancelled(toolCallId: string): ToolResult {
  return {
    toolCallId,
    success: false,
    error: 'cancelled',
    metadata: { cancelledByRun: true },
  };
}

interface Closable {
  close(): Promise<unknown> | unknown;
}

interface Stoppable {
  stop?: () => Promise<unknown> | unknown;
}

interface McpServerTeardownHandles {
  bumpGeneration: () => number;
  generation: () => number | undefined;
  client: () => Closable | undefined;
  dropClientIfCurrent: (client: Closable) => void;
  transport: () => Closable | undefined;
  dropTransportIfCurrent: (transport: Closable) => void;
  inProcess: () => Stoppable | undefined;
  dropInProcessIfCurrent: (server: Stoppable) => void;
  stopListRecovery: () => void;
  wipe: () => void;
}

/**
 * One in-flight disconnect per server. Reconnect waits on this promise so it
 * cannot install a transport that the rest of disconnect() then deletes.
 */
export class ServerTeardownGate {
  private readonly pending = new Map<string, Promise<void>>();

  inflight(serverName: string): Promise<void> | undefined {
    return this.pending.get(serverName);
  }

  async run(serverName: string, teardown: () => Promise<void>): Promise<void> {
    const existing = this.pending.get(serverName);
    if (existing) {
      await existing;
      return this.run(serverName, teardown);
    }
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pending.set(serverName, gate);
    try {
      await teardown();
    } finally {
      if (this.pending.get(serverName) === gate) this.pending.delete(serverName);
      release();
    }
  }
}

/**
 * Close only the client and transport captured at the start. A newer connection
 * keeps its registry entry, status, and stdio child.
 */
export async function teardownOwnedMcpServer(handles: McpServerTeardownHandles): Promise<void> {
  const generation = handles.bumpGeneration();
  const client = handles.client();
  const transport = handles.transport();
  const inProcess = handles.inProcess();
  handles.stopListRecovery();
  if (client) {
    await client.close();
    handles.dropClientIfCurrent(client);
  }
  if (transport) {
    await transport.close();
    handles.dropTransportIfCurrent(transport);
  }
  if (inProcess) {
    if (inProcess.stop) await inProcess.stop();
    handles.dropInProcessIfCurrent(inProcess);
  }
  if (handles.generation() !== generation) return;
  handles.wipe();
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
