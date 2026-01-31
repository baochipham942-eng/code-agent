// src/main/services/checkpoint/fileCheckpointService.ts

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../index';
import { createLogger } from '../infra/logger';
import type { FileCheckpoint, RewindResult, FileCheckpointConfig } from '../../../shared/types';

const logger = createLogger('FileCheckpointService');

const DEFAULT_CONFIG: FileCheckpointConfig = {
  maxFileSizeBytes: 1 * 1024 * 1024, // 1MB
  maxCheckpointsPerSession: 50,
  retentionDays: 7,
};

export class FileCheckpointService {
  private config: FileCheckpointConfig;

  constructor(config: Partial<FileCheckpointConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 创建检查点（工具执行前调用）
   * @returns checkpointId，跳过时返回 null
   */
  async createCheckpoint(
    sessionId: string,
    messageId: string,
    filePath: string
  ): Promise<string | null> {
    const dbService = getDatabase();
    const db = dbService.getDb();
    if (!db) {
      logger.warn('Database not initialized');
      return null;
    }

    try {
      // 解析绝对路径
      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(filePath);

      // 检查文件是否存在
      let fileExisted = false;
      let originalContent: string | null = null;
      let fileSize = 0;

      try {
        const stats = await fs.stat(absolutePath);
        fileExisted = true;
        fileSize = stats.size;

        // 跳过大文件
        if (fileSize > this.config.maxFileSizeBytes) {
          logger.debug('Skipping large file', { filePath: absolutePath, size: fileSize });
          return null;
        }

        originalContent = await fs.readFile(absolutePath, 'utf-8');
      } catch (err) {
        // 文件不存在，这是合法的（新建文件场景）
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err;
        }
      }

      // 检查并强制执行每 session 上限
      await this.enforceLimit(sessionId);

      // 创建检查点
      const id = `ckpt_${Date.now()}_${uuidv4().slice(0, 8)}`;
      const createdAt = Date.now();

      db.prepare(`
        INSERT INTO file_checkpoints (id, session_id, message_id, file_path, original_content, file_existed, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, sessionId, messageId, absolutePath, originalContent, fileExisted ? 1 : 0, createdAt);

      logger.debug('Checkpoint created', { id, sessionId, messageId, filePath: absolutePath, fileExisted });
      return id;
    } catch (error) {
      logger.error('Failed to create checkpoint', { error, sessionId, messageId, filePath });
      return null;
    }
  }

  /**
   * 回滚到指定消息之前的状态
   */
  async rewindFiles(sessionId: string, messageId: string): Promise<RewindResult> {
    const dbService = getDatabase();
    const db = dbService.getDb();
    if (!db) {
      return { success: false, restoredFiles: [], deletedFiles: [], errors: [{ filePath: '', error: 'Database not initialized' }] };
    }

    const result: RewindResult = {
      success: true,
      restoredFiles: [],
      deletedFiles: [],
      errors: [],
    };

    try {
      // 获取目标消息的创建时间
      const targetCheckpoint = db.prepare(`
        SELECT created_at FROM file_checkpoints
        WHERE session_id = ? AND message_id = ?
        ORDER BY created_at ASC LIMIT 1
      `).get(sessionId, messageId) as { created_at: number } | undefined;

      if (!targetCheckpoint) {
        logger.warn('No checkpoint found for message', { sessionId, messageId });
        return { success: false, restoredFiles: [], deletedFiles: [], errors: [{ filePath: '', error: 'No checkpoint found for message' }] };
      }

      // 获取该消息及之后的所有检查点（按时间倒序，最新的先处理）
      const checkpoints = db.prepare(`
        SELECT * FROM file_checkpoints
        WHERE session_id = ? AND created_at >= ?
        ORDER BY created_at DESC
      `).all(sessionId, targetCheckpoint.created_at) as Array<{
        id: string;
        file_path: string;
        original_content: string | null;
        file_existed: number;
      }>;

      if (!checkpoints || checkpoints.length === 0) {
        return result;
      }

      // 按文件路径分组，只保留每个文件最早的检查点（即最原始的状态）
      const fileToOriginal = new Map<string, { content: string | null; existed: boolean }>();
      for (const ckpt of checkpoints) {
        if (!fileToOriginal.has(ckpt.file_path)) {
          fileToOriginal.set(ckpt.file_path, {
            content: ckpt.original_content,
            existed: ckpt.file_existed === 1,
          });
        }
      }

      // 恢复每个文件
      for (const [filePath, original] of fileToOriginal) {
        try {
          if (original.existed) {
            // 文件原本存在，恢复内容
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, original.content || '', 'utf-8');
            result.restoredFiles.push(filePath);
          } else {
            // 文件原本不存在，删除它
            try {
              await fs.unlink(filePath);
              result.deletedFiles.push(filePath);
            } catch (err) {
              // 文件可能已被手动删除，忽略
              if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw err;
              }
            }
          }
        } catch (error) {
          result.success = false;
          result.errors.push({ filePath, error: String(error) });
          logger.error('Failed to restore file', { filePath, error });
        }
      }

      // 删除已回滚的检查点记录
      db.prepare(`
        DELETE FROM file_checkpoints
        WHERE session_id = ? AND created_at >= ?
      `).run(sessionId, targetCheckpoint.created_at);

      logger.info('Files rewound', {
        sessionId,
        messageId,
        restoredCount: result.restoredFiles.length,
        deletedCount: result.deletedFiles.length,
        errorCount: result.errors.length,
      });

      return result;
    } catch (error) {
      logger.error('Failed to rewind files', { error, sessionId, messageId });
      return { success: false, restoredFiles: [], deletedFiles: [], errors: [{ filePath: '', error: String(error) }] };
    }
  }

  /**
   * 获取 session 的所有检查点
   */
  async getCheckpoints(sessionId: string): Promise<FileCheckpoint[]> {
    const dbService = getDatabase();
    const db = dbService.getDb();
    if (!db) return [];

    try {
      const rows = db.prepare(`
        SELECT id, session_id, message_id, file_path, original_content, file_existed, created_at
        FROM file_checkpoints
        WHERE session_id = ?
        ORDER BY created_at DESC
      `).all(sessionId) as Array<{
        id: string;
        session_id: string;
        message_id: string;
        file_path: string;
        original_content: string | null;
        file_existed: number;
        created_at: number;
      }>;

      return (rows || []).map(row => ({
        id: row.id,
        sessionId: row.session_id,
        messageId: row.message_id,
        filePath: row.file_path,
        originalContent: row.original_content,
        fileExisted: row.file_existed === 1,
        createdAt: row.created_at,
      }));
    } catch (error) {
      logger.error('Failed to get checkpoints', { error, sessionId });
      return [];
    }
  }

  /**
   * 清理过期检查点
   */
  async cleanup(): Promise<number> {
    const dbService = getDatabase();
    const db = dbService.getDb();
    if (!db) return 0;

    try {
      const expiryTime = Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000;

      // 删除过期 session 的检查点（基于 session 最后更新时间）
      const result = db.prepare(`
        DELETE FROM file_checkpoints
        WHERE session_id IN (
          SELECT id FROM sessions
          WHERE updated_at < ? OR is_archived = 1
        )
      `).run(expiryTime);

      const deletedCount = result?.changes || 0;
      if (deletedCount > 0) {
        logger.info('Cleaned up expired checkpoints', { count: deletedCount });
      }
      return deletedCount;
    } catch (error) {
      logger.error('Failed to cleanup checkpoints', { error });
      return 0;
    }
  }

  /**
   * 强制执行每 session 上限
   */
  private async enforceLimit(sessionId: string): Promise<void> {
    const dbService = getDatabase();
    const db = dbService.getDb();
    if (!db) return;

    try {
      const countResult = db.prepare(`
        SELECT COUNT(*) as cnt FROM file_checkpoints WHERE session_id = ?
      `).get(sessionId) as { cnt: number } | undefined;

      const count = countResult?.cnt || 0;
      if (count >= this.config.maxCheckpointsPerSession) {
        // 删除最旧的检查点
        const deleteCount = count - this.config.maxCheckpointsPerSession + 1;
        db.prepare(`
          DELETE FROM file_checkpoints
          WHERE id IN (
            SELECT id FROM file_checkpoints
            WHERE session_id = ?
            ORDER BY created_at ASC
            LIMIT ?
          )
        `).run(sessionId, deleteCount);

        logger.debug('Enforced checkpoint limit', { sessionId, deleted: deleteCount });
      }
    } catch (error) {
      logger.error('Failed to enforce limit', { error, sessionId });
    }
  }
}

// Singleton
let instance: FileCheckpointService | null = null;

export function getFileCheckpointService(): FileCheckpointService {
  if (!instance) {
    instance = new FileCheckpointService();
  }
  return instance;
}

export function initFileCheckpointService(config?: Partial<FileCheckpointConfig>): FileCheckpointService {
  instance = new FileCheckpointService(config);
  return instance;
}
