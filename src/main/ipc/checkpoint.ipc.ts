// src/main/ipc/checkpoint.ipc.ts

import type { IpcMain } from 'electron';
import { getFileCheckpointService } from '../services/checkpoint';
import { createLogger } from '../services/infra/logger';
import type { FileCheckpoint, RewindResult } from '../../shared/types';

const logger = createLogger('CheckpointIPC');

/**
 * 注册检查点相关的 IPC handlers
 */
export function registerCheckpointHandlers(ipcMain: IpcMain): void {
  // 获取 session 的检查点列表
  ipcMain.handle('checkpoint:list', async (_, sessionId: string): Promise<FileCheckpoint[]> => {
    try {
      const service = getFileCheckpointService();
      return await service.getCheckpoints(sessionId);
    } catch (error) {
      logger.error('Failed to list checkpoints', { error, sessionId });
      return [];
    }
  });

  // 回滚文件到指定消息之前
  ipcMain.handle('checkpoint:rewind', async (_, sessionId: string, messageId: string): Promise<RewindResult> => {
    try {
      const service = getFileCheckpointService();
      return await service.rewindFiles(sessionId, messageId);
    } catch (error) {
      logger.error('Failed to rewind files', { error, sessionId, messageId });
      return {
        success: false,
        restoredFiles: [],
        deletedFiles: [],
        errors: [{ filePath: '', error: String(error) }],
      };
    }
  });

  // 手动触发清理
  ipcMain.handle('checkpoint:cleanup', async (): Promise<number> => {
    try {
      const service = getFileCheckpointService();
      return await service.cleanup();
    } catch (error) {
      logger.error('Failed to cleanup checkpoints', { error });
      return 0;
    }
  });

  logger.debug('Checkpoint IPC handlers registered');
}
