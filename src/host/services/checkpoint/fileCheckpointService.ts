// src/host/services/checkpoint/fileCheckpointService.ts

import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { atomicWriteFile } from '../../tools/utils/atomicWrite';
import { getDatabase } from '../core';
import { createLogger } from '../infra/logger';
import type { FileCheckpoint, RewindResult, FileCheckpointConfig } from '../../../shared/contract';

const logger = createLogger('FileCheckpointService');

function getCheckpointDatabase() {
  const database = getDatabase();
  return database.isReady ? database.getDb() : null;
}

const MISSING_FILE_DIGEST = 'missing';

export interface RewindFilesOptions {
  /** Snapshot the pre-restore contents under this synthetic message for Redo. */
  redoCheckpointMessageId?: string;
  /** Audit marker written onto retained checkpoint rows. */
  restoredFrom?: string;
  /** Redo restores only its synthetic group, not later checkpoints. */
  exactMessageId?: boolean;
}

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
    filePath: string,
    attribution?: { sourceId?: string; workspaceScopeVersion?: string },
  ): Promise<string | null> {
    const db = getCheckpointDatabase();
    if (!db) return null;

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
        INSERT INTO file_checkpoints (
          id, session_id, message_id, file_path, source_id, workspace_scope_version,
          original_content, file_existed, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        sessionId,
        messageId,
        absolutePath,
        attribution?.sourceId ?? null,
        attribution?.workspaceScopeVersion ?? null,
        originalContent,
        fileExisted ? 1 : 0,
        createdAt,
      );

      logger.debug('Checkpoint created', { id, sessionId, messageId, filePath: absolutePath, fileExisted });
      return id;
    } catch (error) {
      logger.error('Failed to create checkpoint', { error, sessionId, messageId, filePath });
      return null;
    }
  }

  async finalizeCheckpointDigest(checkpointId: string, filePath: string): Promise<boolean> {
    const db = getCheckpointDatabase();
    if (!db) return false;
    try {
      const digest = await this.readCurrentDigest(filePath);
      const result = db.prepare(`
        UPDATE file_checkpoints
        SET post_write_digest = ?
        WHERE id = ?
      `).run(digest, checkpointId);
      return result.changes === 1;
    } catch (error) {
      logger.error('Failed to finalize checkpoint digest', { checkpointId, filePath, error });
      return false;
    }
  }

  /**
   * 回滚到指定消息之前的状态
   */
  async rewindFiles(
    sessionId: string,
    messageId: string,
    options: RewindFilesOptions = {},
  ): Promise<RewindResult> {
    const db = getCheckpointDatabase();
    if (!db) {
      return { success: false, restoredFiles: [], deletedFiles: [], skippedFiles: [], errors: [{ filePath: '', error: 'Database not initialized' }] };
    }

    const result: RewindResult = {
      success: true,
      restoredFiles: [],
      deletedFiles: [],
      skippedFiles: [],
      ...(options.redoCheckpointMessageId
        ? { redoCheckpointMessageId: options.redoCheckpointMessageId }
        : {}),
      errors: [],
    };

    try {
      // 获取目标消息的创建时间
      const targetCheckpoint = db.prepare(`
        SELECT rowid AS checkpoint_rowid, created_at FROM file_checkpoints
        WHERE session_id = ? AND message_id = ?
        ORDER BY created_at ASC, rowid ASC LIMIT 1
      `).get(sessionId, messageId) as { checkpoint_rowid: number; created_at: number } | undefined;

      if (!targetCheckpoint) {
        logger.warn('No checkpoint found for message', { sessionId, messageId });
        return { success: false, restoredFiles: [], deletedFiles: [], skippedFiles: [], errors: [{ filePath: '', error: 'No checkpoint found for message' }] };
      }

      const checkpoints = db.prepare(options.exactMessageId ? `
        SELECT rowid AS checkpoint_rowid, * FROM file_checkpoints
        WHERE session_id = ? AND message_id = ?
        ORDER BY created_at ASC, rowid ASC
      ` : `
        SELECT rowid AS checkpoint_rowid, * FROM file_checkpoints
        WHERE session_id = ?
          AND message_id NOT LIKE 'turn_redo_snapshot_%'
          AND (created_at > ? OR (created_at = ? AND rowid >= ?))
        ORDER BY created_at ASC, rowid ASC
      `).all(...(options.exactMessageId
        ? [sessionId, messageId]
        : [sessionId, targetCheckpoint.created_at, targetCheckpoint.created_at, targetCheckpoint.checkpoint_rowid])) as Array<{
        id: string;
        file_path: string;
        original_content: string | null;
        file_existed: number;
        post_write_digest: string | null;
        restored_from: string | null;
      }>;

      if (!checkpoints || checkpoints.length === 0) {
        return result;
      }

      // 按文件路径分组，只保留每个文件最早的检查点（即最原始的状态）
      const fileToOriginal = new Map<string, {
        content: string | null;
        existed: boolean;
        expectedDigest: string | null;
        checkpointIds: string[];
        restoredFromMarkers: Array<string | null>;
      }>();
      for (const ckpt of checkpoints) {
        const existing = fileToOriginal.get(ckpt.file_path);
        if (!existing) {
          fileToOriginal.set(ckpt.file_path, {
            content: ckpt.original_content,
            existed: ckpt.file_existed === 1,
            expectedDigest: ckpt.post_write_digest,
            checkpointIds: [ckpt.id],
            restoredFromMarkers: [ckpt.restored_from],
          });
        } else {
          existing.checkpointIds.push(ckpt.id);
          existing.restoredFromMarkers.push(ckpt.restored_from);
          if (ckpt.post_write_digest) existing.expectedDigest = ckpt.post_write_digest;
        }
      }

      // 恢复每个文件
      for (const [filePath, original] of fileToOriginal) {
        try {
          const alreadyRestored = options.restoredFrom
            && options.redoCheckpointMessageId
            && original.restoredFromMarkers.every((marker) => marker === options.restoredFrom)
            && Boolean(db.prepare(`
              SELECT 1
              FROM file_checkpoints
              WHERE session_id = ? AND message_id = ? AND file_path = ?
              LIMIT 1
            `).get(sessionId, options.redoCheckpointMessageId, filePath));
          if (alreadyRestored) {
            if (original.existed) result.restoredFiles.push(filePath);
            else result.deletedFiles.push(filePath);
            continue;
          }
          if (!original.expectedDigest) {
            result.skippedFiles.push({
              filePath,
              reason: 'missing_post_write_digest',
              detail: 'The checkpoint predates persisted agent post-write digests.',
            });
            continue;
          }
          const currentDigest = await this.readCurrentDigest(filePath);
          if (currentDigest !== original.expectedDigest) {
            result.skippedFiles.push({
              filePath,
              reason: 'human_edit',
              detail: `Current digest ${currentDigest} differs from the agent write ${original.expectedDigest}.`,
            });
            continue;
          }
          let redoCheckpointId: string | null = null;
          if (options.redoCheckpointMessageId) {
            redoCheckpointId = await this.createCheckpoint(
              sessionId,
              options.redoCheckpointMessageId,
              filePath,
            );
            if (!redoCheckpointId) {
              result.skippedFiles.push({
                filePath,
                reason: 'redo_snapshot_failed',
                detail: 'The current file could not be snapshotted safely before restore.',
              });
              continue;
            }
          }
          const beforeWriteDigest = await this.readCurrentDigest(filePath);
          if (beforeWriteDigest !== original.expectedDigest) {
            result.skippedFiles.push({
              filePath,
              reason: 'human_edit',
              detail: 'The file changed while the restore snapshot was being prepared.',
            });
            continue;
          }
          if (original.existed) {
            // 文件原本存在，恢复内容
            await atomicWriteFile(filePath, original.content || '', 'utf-8');
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
          if (redoCheckpointId) {
            const finalized = await this.finalizeCheckpointDigest(redoCheckpointId, filePath);
            if (!finalized) {
              result.errors.push({
                filePath,
                error: 'Redo checkpoint digest could not be finalized after restore',
              });
            }
          }
          if (options.restoredFrom && original.checkpointIds.length > 0) {
            const placeholders = original.checkpointIds.map(() => '?').join(', ');
            db.prepare(`
              UPDATE file_checkpoints
              SET restored_from = ?
              WHERE id IN (${placeholders})
            `).run(options.restoredFrom, ...original.checkpointIds);
          }
        } catch (error) {
          result.success = false;
          result.errors.push({ filePath, error: String(error) });
          logger.error('Failed to restore file', { filePath, error });
        }
      }

      result.success = result.errors.length === 0 && result.skippedFiles.length === 0;

      logger.info('Files rewound', {
        sessionId,
        messageId,
        restoredCount: result.restoredFiles.length,
        deletedCount: result.deletedFiles.length,
        errorCount: result.errors.length,
        skippedCount: result.skippedFiles.length,
      });

      return result;
    } catch (error) {
      logger.error('Failed to rewind files', { error, sessionId, messageId });
      return { success: false, restoredFiles: [], deletedFiles: [], skippedFiles: [], errors: [{ filePath: '', error: String(error) }] };
    }
  }

  async redoFiles(
    sessionId: string,
    redoCheckpointMessageId: string,
    restoredFrom: string,
  ): Promise<RewindResult> {
    return this.rewindFiles(sessionId, redoCheckpointMessageId, {
      exactMessageId: true,
      restoredFrom,
    });
  }

  async getFirstCheckpointAtOrAfter(
    sessionId: string,
    timestamp: number,
  ): Promise<{ messageId: string; createdAt: number } | null> {
    const db = getCheckpointDatabase();
    if (!db) return null;

    try {
      const row = db.prepare(`
        SELECT message_id, created_at
        FROM file_checkpoints
        WHERE session_id = ?
          AND created_at >= ?
          AND message_id NOT LIKE 'turn_redo_snapshot_%'
        ORDER BY created_at ASC, rowid ASC
        LIMIT 1
      `).get(sessionId, timestamp) as { message_id: string; created_at: number } | undefined;

      return row
        ? { messageId: row.message_id, createdAt: row.created_at }
        : null;
    } catch (error) {
      logger.error('Failed to find checkpoint after timestamp', { error, sessionId, timestamp });
      return null;
    }
  }

  /**
   * 获取 session 的所有检查点
   */
  async getCheckpoints(sessionId: string): Promise<FileCheckpoint[]> {
    const db = getCheckpointDatabase();
    if (!db) return [];

    try {
      const rows = db.prepare(`
        SELECT id, session_id, message_id, file_path, source_id, workspace_scope_version,
               original_content, file_existed, post_write_digest, restored_from, created_at
        FROM file_checkpoints
        WHERE session_id = ?
        ORDER BY created_at DESC
      `).all(sessionId) as Array<{
        id: string;
        session_id: string;
        message_id: string;
        file_path: string;
        source_id: string | null;
        workspace_scope_version: string | null;
        original_content: string | null;
        file_existed: number;
        post_write_digest: string | null;
        restored_from: string | null;
        created_at: number;
      }>;

      return (rows || []).map(row => ({
        id: row.id,
        sessionId: row.session_id,
        messageId: row.message_id,
        filePath: row.file_path,
        sourceId: row.source_id ?? undefined,
        workspaceScopeVersion: row.workspace_scope_version ?? undefined,
        originalContent: row.original_content,
        fileExisted: row.file_existed === 1,
        postWriteDigest: row.post_write_digest ?? undefined,
        restoredFrom: row.restored_from ?? undefined,
        createdAt: row.created_at,
      }));
    } catch (error) {
      logger.error('Failed to get checkpoints', { error, sessionId });
      return [];
    }
  }

  private async readCurrentDigest(filePath: string): Promise<string> {
    try {
      const content = await fs.readFile(filePath);
      return `sha256:${createHash('sha256').update(content).digest('hex')}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return MISSING_FILE_DIGEST;
      throw error;
    }
  }

  /**
   * 清理过期检查点
   */
  async cleanup(): Promise<number> {
    const db = getCheckpointDatabase();
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
    const db = getCheckpointDatabase();
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
            ORDER BY created_at ASC, rowid ASC
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
