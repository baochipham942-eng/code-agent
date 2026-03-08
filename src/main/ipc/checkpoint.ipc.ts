// src/main/ipc/checkpoint.ipc.ts

import type { IpcMain } from 'electron';
import { getFileCheckpointService } from '../services/checkpoint';
import { getDatabase } from '../services';
import { createLogger } from '../services/infra/logger';
import type { FileCheckpoint } from '../../shared/types';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { AgentOrchestrator } from '../agent/agentOrchestrator';

const logger = createLogger('CheckpointIPC');

interface CheckpointHandlerDeps {
  getOrchestrator: () => AgentOrchestrator | null;
}

/**
 * 注册检查点相关的 IPC handlers
 */
export function registerCheckpointHandlers(ipcMain: IpcMain, deps?: CheckpointHandlerDeps): void {
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

  // Rewind UI: 回滚到指定消息（文件恢复 + 消息截断）
  ipcMain.handle(IPC_CHANNELS.CHECKPOINT_REWIND, async (_, sessionId: string, messageId: string) => {
    try {
      const service = getFileCheckpointService();

      // 1. 恢复文件
      const result = await service.rewindFiles(sessionId, messageId);
      if (!result.success) {
        return {
          success: false,
          filesRestored: 0,
          messagesRemoved: 0,
          error: result.errors.map(e => e.error).join('; '),
        };
      }

      // 2. 截断对话消息（删除该检查点时间戳及之后的消息）
      let messagesRemoved = 0;
      try {
        const checkpoints = await service.getCheckpoints(sessionId);
        // 找到最早的检查点时间作为截断点（getCheckpoints 按 createdAt DESC，取 last）
        const allForMessage = checkpoints.filter(cp => cp.messageId === messageId);
        const earliest = allForMessage.length > 0
          ? Math.min(...allForMessage.map(cp => cp.createdAt))
          : 0;

        if (earliest > 0) {
          const dbService = getDatabase();
          messagesRemoved = dbService.deleteMessagesFrom(sessionId, earliest);
          logger.info('Messages truncated on rewind', { sessionId, from: earliest, removed: messagesRemoved });

          // 同步 orchestrator 内存中的消息
          const orchestrator = deps?.getOrchestrator();
          if (orchestrator) {
            const remainingMessages = dbService.getMessages(sessionId);
            orchestrator.setMessages(remainingMessages);
          }
        }
      } catch (msgErr) {
        // 消息截断失败不影响文件恢复结果
        logger.error('Failed to truncate messages on rewind', { error: msgErr, sessionId });
      }

      return {
        success: true,
        filesRestored: result.restoredFiles.length + result.deletedFiles.length,
        messagesRemoved,
        error: result.errors.length > 0 ? result.errors.map(e => e.error).join('; ') : undefined,
      };
    } catch (error) {
      logger.error('Failed to rewind', { error, sessionId, messageId });
      return { success: false, filesRestored: 0, messagesRemoved: 0, error: String(error) };
    }
  });

  // Rewind UI: 预览回滚影响（显示从该消息到最新的所有受影响文件）
  ipcMain.handle(IPC_CHANNELS.CHECKPOINT_PREVIEW, async (_, sessionId: string, messageId: string) => {
    try {
      const service = getFileCheckpointService();
      const checkpoints = await service.getCheckpoints(sessionId);

      // 找到目标 messageId 的最早时间戳
      const targetCheckpoints = checkpoints.filter(cp => cp.messageId === messageId);
      if (targetCheckpoints.length === 0) return [];
      const earliestTime = Math.min(...targetCheckpoints.map(cp => cp.createdAt));

      // 获取该时间戳及之后的所有检查点（与 rewindFiles 逻辑一致）
      const affected = checkpoints.filter(cp => cp.createdAt >= earliestTime);

      // 按文件去重，只保留每个文件的状态
      const fileMap = new Map<string, 'added' | 'modified'>();
      for (const cp of affected) {
        if (!fileMap.has(cp.filePath)) {
          fileMap.set(cp.filePath, cp.fileExisted ? 'modified' : 'added');
        }
      }

      return Array.from(fileMap.entries()).map(([filePath, status]) => ({
        filePath,
        status,
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
