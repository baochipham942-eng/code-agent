// ============================================================================
// Channel IPC Handlers - channel:* 通道
// 处理多通道接入相关的 IPC 通信
// ============================================================================

import type { IpcMain, BrowserWindow } from 'electron';
import { CHANNEL_CHANNELS } from '../../shared/ipc/channels';
import { getChannelManager } from '../channels';
import type {
  ChannelType,
  ChannelAccount,
  ChannelAccountConfig,
  AddChannelAccountRequest,
  UpdateChannelAccountRequest,
} from '../../shared/types/channel';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ChannelIPC');

// ----------------------------------------------------------------------------
// Public Registration
// ----------------------------------------------------------------------------

/**
 * 注册 Channel 相关 IPC handlers
 */
export function registerChannelHandlers(
  ipcMain: IpcMain,
  getMainWindow: () => BrowserWindow | null
): void {
  const channelManager = getChannelManager();

  // 监听通道事件并转发到渲染进程
  channelManager.on('account_status_change', (accountId, status, error) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(CHANNEL_CHANNELS.ACCOUNT_STATUS_CHANGED, {
        accountId,
        status,
        error,
      });
    }
  });

  channelManager.on('accounts_changed', (accounts) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(CHANNEL_CHANNELS.ACCOUNTS_CHANGED, accounts);
    }
  });

  // 获取所有账号
  ipcMain.handle(CHANNEL_CHANNELS.LIST_ACCOUNTS, async (): Promise<ChannelAccount[]> => {
    return channelManager.getAccounts();
  });

  // 获取可用通道类型
  ipcMain.handle(CHANNEL_CHANNELS.GET_CHANNEL_TYPES, async (): Promise<Array<{
    type: ChannelType;
    name: string;
    description?: string;
  }>> => {
    const types = channelManager.getRegisteredChannelTypes();
    return types.map(type => {
      const meta = channelManager.getChannelMeta(type);
      return {
        type,
        name: meta?.name || type,
        description: meta?.description,
      };
    });
  });

  // 添加账号
  ipcMain.handle(
    CHANNEL_CHANNELS.ADD_ACCOUNT,
    async (_, request: AddChannelAccountRequest): Promise<ChannelAccount> => {
      logger.info('Adding channel account', { name: request.name, type: request.type });
      return channelManager.addAccount(
        request.name,
        request.type,
        request.config,
        request.defaultAgentId
      );
    }
  );

  // 更新账号
  ipcMain.handle(
    CHANNEL_CHANNELS.UPDATE_ACCOUNT,
    async (_, request: UpdateChannelAccountRequest): Promise<ChannelAccount | null> => {
      logger.info('Updating channel account', { id: request.id });
      return channelManager.updateAccount(request.id, {
        name: request.name,
        config: request.config,
        enabled: request.enabled,
        defaultAgentId: request.defaultAgentId,
      });
    }
  );

  // 删除账号
  ipcMain.handle(
    CHANNEL_CHANNELS.DELETE_ACCOUNT,
    async (_, accountId: string): Promise<boolean> => {
      logger.info('Deleting channel account', { accountId });
      return channelManager.deleteAccount(accountId);
    }
  );

  // 连接账号
  ipcMain.handle(
    CHANNEL_CHANNELS.CONNECT_ACCOUNT,
    async (_, accountId: string): Promise<{ success: boolean; error?: string }> => {
      logger.info('Connecting channel account', { accountId });
      try {
        await channelManager.connectAccount(accountId);
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.error('Failed to connect account', { accountId, error: message });
        return { success: false, error: message };
      }
    }
  );

  // 断开账号
  ipcMain.handle(
    CHANNEL_CHANNELS.DISCONNECT_ACCOUNT,
    async (_, accountId: string): Promise<{ success: boolean; error?: string }> => {
      logger.info('Disconnecting channel account', { accountId });
      try {
        await channelManager.disconnectAccount(accountId);
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: message };
      }
    }
  );

  logger.info('Channel IPC handlers registered');
}
