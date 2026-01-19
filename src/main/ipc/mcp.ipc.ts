// ============================================================================
// MCP IPC Handlers - mcp:* 通道
// ============================================================================

import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc';
import { getMCPClient } from '../mcp/MCPClient';

/**
 * 注册 MCP 相关 IPC handlers
 */
export function registerMcpHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_CHANNELS.MCP_GET_STATUS, async () => {
    const mcpClient = getMCPClient();
    return mcpClient.getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.MCP_LIST_TOOLS, async () => {
    const mcpClient = getMCPClient();
    return mcpClient.getTools();
  });

  ipcMain.handle(IPC_CHANNELS.MCP_LIST_RESOURCES, async () => {
    const mcpClient = getMCPClient();
    return mcpClient.getResources();
  });
}
