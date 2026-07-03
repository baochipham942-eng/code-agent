// ============================================================================
// Agent Registry IPC Handlers - agents:* 通道
// ============================================================================
//
// 暴露：
// - action 'list'  -> listAllAgents()，含 builtin + user + project
// - 主进程主动推送 'agents:changed' 事件给所有 BrowserWindow
// ============================================================================

import type { IpcMain, AppWindow } from '../platform';
import { IPC_CHANNELS, IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import {
  listAllAgentsWithRoleFlag,
  onAgentRegistryChange,
} from '../agent/agentRegistry';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('AgentRegistryIPC');

/**
 * 主进程 → 渲染端推送的事件通道。
 * 同步暴露为 IPC_CHANNELS.AGENTS_CHANGED（type-safe），保留常量便于本模块内部引用。
 */
export const AGENT_REGISTRY_EVENT = IPC_CHANNELS.AGENTS_CHANGED;

export function registerAgentRegistryHandlers(
  ipcMain: IpcMain,
  getAllWindows: () => AppWindow[],
): void {
  ipcMain.handle(IPC_DOMAINS.AGENT_REGISTRY, async (_event, request: IPCRequest): Promise<IPCResponse> => {
    const { action } = request;
    try {
      switch (action) {
        case 'list': {
          const entries = await listAllAgentsWithRoleFlag();
          return { success: true, data: entries };
        }
        default:
          return {
            success: false,
            error: { code: 'UNKNOWN_ACTION', message: `Unknown agents action: ${action}` },
          };
      }
    } catch (error) {
      logger.error('AgentRegistry IPC error', error);
      return {
        success: false,
        error: {
          code: 'AGENT_REGISTRY_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  });

  // Broadcast 'agents:changed' to all renderer windows
  onAgentRegistryChange(() => {
    void (async () => {
      try {
        const windows = getAllWindows();
        const entries = await listAllAgentsWithRoleFlag();
        for (const win of windows) {
          if (!win.isDestroyed()) {
            win.webContents.send(AGENT_REGISTRY_EVENT, { agents: entries });
          }
        }
      } catch (err) {
        logger.warn('Failed to broadcast agents:changed', { error: String(err) });
      }
    })();
  });

  logger.info('AgentRegistry IPC handlers registered');
}
