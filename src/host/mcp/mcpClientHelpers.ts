// N-MAXLINES-MINEFIELD-2-FU1-S6 move-only extraction: stateless tool-call
// helpers moved byte-identical from mcpClient.ts. mcpClient.ts re-exports
// shouldSuppressCuaAutoReplay / shouldBlockRawCuaInvocation so existing
// importers keep their original import paths.
import type { ToolResult } from '../../shared/contract';
import { CUA_DRIVER_SERVER_NAME } from './types';
import { CUA_READONLY_TOOLS } from './cuaSessionLock';
import { isCuaStateV2Enabled } from './cuaStateConfig';

export interface MCPToolCallOptions {
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  /** 会话 ID（GAP-009: 超阈值输出落盘到 session 临时目录） */
  sessionId?: string;
  /** Internal capability: only the stateful CUA facade may invoke raw driver tools. */
  cuaStatefulFacade?: boolean;
  cuaLockScope?: string; // Surface Session owner for input lock and trajectory budget.
}

export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === 'AbortError' || error.message.toLowerCase().includes('abort');
}

export function buildCancelledToolResult(toolCallId: string): ToolResult {
  return {
    toolCallId,
    success: false,
    error: 'cancelled',
    metadata: {
      cancelledByRun: true,
    },
  };
}

export function shouldSuppressCuaAutoReplay(
  serverName: string,
  toolName: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return serverName === CUA_DRIVER_SERVER_NAME
    && isCuaStateV2Enabled(env)
    && !CUA_READONLY_TOOLS.has(toolName);
}

export function shouldBlockRawCuaInvocation(
  serverName: string,
  options: MCPToolCallOptions | number,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return serverName === CUA_DRIVER_SERVER_NAME
    && isCuaStateV2Enabled(env)
    && (typeof options === 'number' || options.cuaStatefulFacade !== true);
}
