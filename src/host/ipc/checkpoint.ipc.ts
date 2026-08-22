// src/host/ipc/checkpoint.ipc.ts

import type { IpcMain } from '../platform';
import { getFileCheckpointService } from '../services/checkpoint';
import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';
import type { FileCheckpoint } from '../../shared/contract';
import type { AgentApplicationService } from '../../shared/contract/appService';
import { IPC_CHANNELS } from '../../shared/ipc';

const logger = createLogger('CheckpointIPC');

/**
 * 注册检查点相关的 IPC handlers
 */
export function registerCheckpointHandlers(
  ipcMain: IpcMain,
  getAppService: () => AgentApplicationService | null,
): void {
  // 获取检查点列表（按 messageId 分组）
  ipcMain.handle(IPC_CHANNELS.CHECKPOINT_LIST, async (_, sessionId: string) => {
    try {
      const service = getFileCheckpointService();
      const checkpoints = (await service.getCheckpoints(sessionId))
        .filter((checkpoint) => !checkpoint.messageId.startsWith('turn_redo_snapshot_'));
      const userMessages = getDatabase().getMessages(sessionId)
        .filter((message) => message.role === 'user')
        .sort((left, right) => left.timestamp - right.timestamp);
      const messageMap = new Map<string, {
        checkpoint: FileCheckpoint;
        anchorUserMessageId?: string;
        filePaths: Set<string>;
      }>();
      for (const cp of checkpoints) {
        const anchor = [...userMessages].reverse().find((message) => message.timestamp <= cp.createdAt);
        const groupId = anchor?.id ?? cp.messageId;
        const existing = messageMap.get(groupId);
        if (existing) {
          existing.filePaths.add(cp.filePath);
          if (cp.createdAt < existing.checkpoint.createdAt) existing.checkpoint = cp;
        } else {
          messageMap.set(groupId, {
            checkpoint: cp,
            anchorUserMessageId: anchor?.id,
            filePaths: new Set([cp.filePath]),
          });
        }
      }
      return Array.from(messageMap.values()).map(({ checkpoint, anchorUserMessageId, filePaths }) => ({
        id: checkpoint.id,
        timestamp: checkpoint.createdAt,
        messageId: checkpoint.messageId,
        anchorUserMessageId,
        description: anchorUserMessageId
          ? userMessages.find((message) => message.id === anchorUserMessageId)?.content.slice(0, 80)
          : undefined,
        fileCount: filePaths.size,
      }));
    } catch (error) {
      logger.error('Failed to list checkpoints', { error, sessionId });
      return [];
    }
  });

  // Rewind UI: 回滚到指定消息
  ipcMain.handle(IPC_CHANNELS.CHECKPOINT_REWIND, async (_, sessionId: string, messageId: string) => {
    try {
      const appService = getAppService();
      if (!appService) {
        throw new Error('Agent application service is unavailable');
      }
      const result = await appService.restoreWorkspaceFilesAtCheckpoint({
        sessionId,
        checkpointMessageId: messageId,
      });
      return {
        success: result.success,
        filesRestored: result.restoredFileCount + result.deletedFileCount,
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

  // Compatibility tombstone only. The former implementation rewound source
  // files and physically deleted source messages, so it must never execute.
  // User Fork is now the domain:session/fork application-service operation.
  ipcMain.handle(IPC_CHANNELS.CHECKPOINT_FORK, async () => {
    return {
      success: false,
      code: 'LEGACY_FORK_RETIRED',
      filesRestored: 0,
      messagesTruncated: 0,
      error: 'checkpoint:fork was retired; use domain:session/fork',
    };
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
