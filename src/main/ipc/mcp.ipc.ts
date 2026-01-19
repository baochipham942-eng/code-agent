// ============================================================================
// MCP IPC Handlers - mcp:* 通道
// ============================================================================

import type { IpcMain } from 'electron';
import { IPC_CHANNELS, IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import { getMCPClient } from '../mcp/mcpClient';

// ----------------------------------------------------------------------------
// Internal Handlers
// ----------------------------------------------------------------------------

async function handleGetStatus(): Promise<unknown> {
  return getMCPClient().getStatus();
}

async function handleListTools(): Promise<unknown> {
  return getMCPClient().getTools();
}

async function handleListResources(): Promise<unknown> {
  return getMCPClient().getResources();
}

// ----------------------------------------------------------------------------
// Public Registration
// ----------------------------------------------------------------------------

/**
 * 注册 MCP 相关 IPC handlers
 */
export function registerMcpHandlers(ipcMain: IpcMain): void {
  // ========== New Domain Handler (TASK-04) ==========
  ipcMain.handle(IPC_DOMAINS.MCP, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action } = request;

    try {
      let data: unknown;

      switch (action) {
        case 'getStatus':
          data = await handleGetStatus();
          break;
        case 'listTools':
          data = await handleListTools();
          break;
        case 'listResources':
          data = await handleListResources();
          break;
        default:
          return { success: false, error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` } };
      }

      return { success: true, data };
    } catch (error) {
      return { success: false, error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) } };
    }
  });

  // ========== Legacy Handlers (Deprecated) ==========

  /** @deprecated Use IPC_DOMAINS.MCP with action: 'getStatus' */
  ipcMain.handle(IPC_CHANNELS.MCP_GET_STATUS, async () => handleGetStatus());

  /** @deprecated Use IPC_DOMAINS.MCP with action: 'listTools' */
  ipcMain.handle(IPC_CHANNELS.MCP_LIST_TOOLS, async () => handleListTools());

  /** @deprecated Use IPC_DOMAINS.MCP with action: 'listResources' */
  ipcMain.handle(IPC_CHANNELS.MCP_LIST_RESOURCES, async () => handleListResources());
}
