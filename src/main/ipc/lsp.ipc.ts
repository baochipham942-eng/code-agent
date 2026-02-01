// ============================================================================
// LSP IPC Handlers - 语言服务器状态查询
// ============================================================================

import { ipcMain } from 'electron';
import { LSP_CHANNELS } from '../../shared/ipc/channels';
import {
  getLSPManager,
  initializeLSPManager,
  checkLSPServerInstalled,
  defaultLSPConfigs,
} from '../lsp';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('LSP-IPC');

/**
 * LSP 服务器状态信息
 */
export interface LSPServerStatus {
  name: string;
  status: 'initializing' | 'ready' | 'error' | 'stopped' | 'not_installed';
  fileExtensions: string[];
}

/**
 * LSP 整体状态
 */
export interface LSPStatus {
  initialized: boolean;
  workspaceRoot: string | null;
  servers: LSPServerStatus[];
}

/**
 * 注册 LSP IPC 处理器
 */
export function registerLSPHandlers(): void {
  // 获取 LSP 状态
  ipcMain.handle(LSP_CHANNELS.GET_STATUS, async (): Promise<LSPStatus> => {
    const manager = getLSPManager();

    if (!manager) {
      return {
        initialized: false,
        workspaceRoot: null,
        servers: defaultLSPConfigs.map((config) => ({
          name: config.name,
          status: checkLSPServerInstalled(config.name) ? 'stopped' : 'not_installed',
          fileExtensions: config.fileExtensions,
        })),
      };
    }

    const managerStatus = manager.getStatus();
    const allServers = manager.getAllServers();

    const servers: LSPServerStatus[] = defaultLSPConfigs.map((config) => {
      const server = allServers.get(config.name);
      if (server) {
        return {
          name: config.name,
          status: server.getState(),
          fileExtensions: config.fileExtensions,
        };
      }
      return {
        name: config.name,
        status: checkLSPServerInstalled(config.name) ? 'stopped' : 'not_installed',
        fileExtensions: config.fileExtensions,
      };
    });

    return {
      initialized: managerStatus.status === 'ready',
      workspaceRoot: null, // Will be set when we have access to it
      servers,
    };
  });

  // 检查语言服务器安装状态
  ipcMain.handle(LSP_CHANNELS.CHECK_SERVERS, async (): Promise<Record<string, boolean>> => {
    const result: Record<string, boolean> = {};

    for (const config of defaultLSPConfigs) {
      result[config.name] = checkLSPServerInstalled(config.name);
    }

    return result;
  });

  // 手动初始化 LSP
  ipcMain.handle(LSP_CHANNELS.INITIALIZE, async (_event, workspaceRoot: string): Promise<boolean> => {
    try {
      logger.info('Manually initializing LSP', { workspaceRoot });
      await initializeLSPManager(workspaceRoot);
      logger.info('LSP initialized successfully');
      return true;
    } catch (error) {
      logger.error('Failed to initialize LSP', { error });
      return false;
    }
  });

  logger.info('LSP IPC handlers registered');
}
