// src/main/ipc/checkpoint.ipc.ts

import type { IpcMain } from '../platform';
import { getFileCheckpointService } from '../services/checkpoint';
import { createLogger } from '../services/infra/logger';
import type { FileCheckpoint } from '../../shared/types';
import { IPC_CHANNELS } from '../../shared/ipc';

const logger = createLogger('CheckpointIPC');

/**
 * 注册检查点相关的 IPC handlers
 */
export function registerCheckpointHandlers(ipcMain: IpcMain): void {
  // 获取检查点列表（按 messageId 分组）
  ipcMain.handle(IPC_CHANNELS.CHECKPOINT_LIST, async (_, sessionId: string) => {
    try {
      const service = getFileCheckpointService();
      const checkpoints = await service.getCheckpoints(sessionId);
      const messageMap = new Map<string, { checkpoint: FileCheckpoint; fileCount: number }>();
      for (const cp of checkpoints) {
        const existing = messageMap.get(cp.messageId);
        if (existing) {
          existing.fileCount++;
        } else {
          messageMap.set(cp.messageId, { checkpoint: cp, fileCount: 1 });
        }
      }
      return Array.from(messageMap.values()).map(({ checkpoint, fileCount }) => ({
        id: checkpoint.id,
        timestamp: checkpoint.createdAt,
        messageId: checkpoint.messageId,
        fileCount,
      }));
    } catch (error) {
      logger.error('Failed to list checkpoints', { error, sessionId });
      return [];
    }
  });

  // Rewind UI: 回滚到指定消息
  ipcMain.handle(IPC_CHANNELS.CHECKPOINT_REWIND, async (_, sessionId: string, messageId: string) => {
    try {
      const service = getFileCheckpointService();
      const result = await service.rewindFiles(sessionId, messageId);
      return {
        success: result.success,
        filesRestored: result.restoredFiles.length + result.deletedFiles.length,
        error: result.errors.length > 0 ? result.errors.map(e => e.error).join('; ') : undefined,
      };
    } catch (error) {
      logger.error('Failed to rewind', { error, sessionId, messageId });
      return { success: false, filesRestored: 0, error: String(error) };
    }
  });

  // Rewind UI: 预览检查点变更
  ipcMain.handle(IPC_CHANNELS.CHECKPOINT_PREVIEW, async (_, sessionId: string, messageId: string) => {
    try {
      const service = getFileCheckpointService();
      const checkpoints = await service.getCheckpoints(sessionId);
      // Find all checkpoints for this messageId
      const relevant = checkpoints.filter(cp => cp.messageId === messageId);
      return relevant.map(cp => ({
        filePath: cp.filePath,
        status: cp.fileExisted ? 'modified' as const : 'added' as const,
      }));
    } catch (error) {
      logger.error('Failed to preview checkpoint', { error, sessionId, messageId });
      return [];
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
