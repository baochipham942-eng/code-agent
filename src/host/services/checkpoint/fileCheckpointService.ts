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

/**
 * 一个路径能否进**无损**快照（返修 r2）。二进制/非 utf-8 的判据用 Buffer 做
 * 解码再编码的往返比对，不靠 utf-8 字符串——有损读入的字符串看不出自己有损。
 */
type SnapshotEligibility = {
  /** 配对判据用：false = 建不出无损快照，移动配对里出现即整单撤下。目录为 true（无内容可丢）。 */
  eligible: boolean;
  /** 是否尝试落快照行（目录等建不出行的为 false）。 */
  snapshotable: boolean;
  reason?: 'directory' | 'too_large' | 'read_error' | 'non_utf8_content' | 'unsupported_file_type';
};

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

  /**
   * 评估一个路径能否被无损快照（工具执行前调用，返修 r2）：
   * - 文件不存在 → 可快照（新建文件场景，回退时删除）；
   * - 目录 → 配对不算失败（没有可丢的内容），但快照行建不出来（snapshotable=false）；
   * - 超过 maxFileSizeBytes、读错误、非 utf-8 内容（二进制）→ 不可快照；
   * - 字符/块设备、FIFO 等非常规文件 → 不读（读它们可能阻塞），按不可快照处理。
   * createCheckpoint 对这几类要么返回 null 要么按 utf-8 有损存入（回退写回损坏内容），
   * 调用方（移动配对判据）必须先问这里。
   */
  async assessSnapshotEligibility(filePath: string): Promise<SnapshotEligibility> {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(filePath);

    let stats: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stats = await fs.stat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { eligible: true, snapshotable: true };
      }
      return { eligible: false, snapshotable: false, reason: 'read_error' };
    }
    if (stats.isDirectory()) {
      return { eligible: true, snapshotable: false, reason: 'directory' };
    }
    if (!stats.isFile()) {
      return { eligible: false, snapshotable: false, reason: 'unsupported_file_type' };
    }
    if (stats.size > this.config.maxFileSizeBytes) {
      return { eligible: false, snapshotable: false, reason: 'too_large' };
    }
    let content: Buffer;
    try {
      content = await fs.readFile(absolutePath);
    } catch {
      return { eligible: false, snapshotable: false, reason: 'read_error' };
    }
    // utf-8 无损往返判据：解码再编码回不去（坏字节被替换成 U+FFFD）= 二进制/非 utf-8，
    // 硬存进快照，回退时写回的就是损坏内容。
    if (!Buffer.from(content.toString('utf-8'), 'utf-8').equals(content)) {
      return { eligible: false, snapshotable: false, reason: 'non_utf8_content' };
    }
    return { eligible: true, snapshotable: true };
  }

  /**
   * 撤下刚建的检查点行（移动配对失败整单撤回用，返修 r2）：只按本调用拿到的
   * id 删，不触碰其他调用的行。返回实际删除数。
   */
  deleteCheckpoints(checkpointIds: string[]): number {
    if (checkpointIds.length === 0) return 0;
    const db = getCheckpointDatabase();
    if (!db) return 0;
    try {
      const placeholders = checkpointIds.map(() => '?').join(', ');
      const result = db.prepare(`
        DELETE FROM file_checkpoints
        WHERE id IN (${placeholders})
      `).run(...checkpointIds);
      return result?.changes ?? 0;
    } catch (error) {
      logger.error('Failed to delete checkpoints', { error, checkpointIds });
      return 0;
    }
  }

  /**
   * 这些检查点行还有几条存活（返修 r3 Nit）：enforceLimit 可能在同一次调用的连续
   * 创建中途逐出先建的行，移动配对判据要复查成员齐不齐。读失败按 0 计——调用方会
   * 走整单撤下 + 披露的保守方向。
   */
  countCheckpoints(checkpointIds: string[]): number {
    if (checkpointIds.length === 0) return 0;
    const db = getCheckpointDatabase();
    if (!db) return 0;
    try {
      const placeholders = checkpointIds.map(() => '?').join(', ');
      const row = db.prepare(`
        SELECT COUNT(*) AS cnt FROM file_checkpoints
        WHERE id IN (${placeholders})
      `).get(...checkpointIds) as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    } catch (error) {
      logger.error('Failed to count checkpoints', { error, checkpointIds });
      return 0;
    }
  }

  /**
   * 记录一个解析不出的写目标（含通配/变量的重定向等）。
   * 不落快照内容，只在回退时进 skippedFiles 披露「无法确定写入目标」。
   * 同一 session 同一披露键只留最新一条（返修 r3：同一目标反复出现不去重，会按每次
   * 工具调用一条无上限增长）；回退窗口按 created_at 取，最新一条总能代表该目标最近的
   * 一次不确定写入，更早的重复行不增加任何披露信息。披露行也有自己的总量上限
   * （enforceLimit），不占真快照的预算。
   * @returns 记录 id，失败返回 null
   */
  async recordUncertainWriteTarget(
    sessionId: string,
    messageId: string,
    uncertainTarget: string,
    attribution?: { workspaceScopeVersion?: string },
  ): Promise<string | null> {
    const db = getCheckpointDatabase();
    if (!db) return null;

    try {
      await this.enforceLimit(sessionId);

      db.prepare(`
        DELETE FROM file_checkpoints
        WHERE session_id = ? AND file_path = ? AND uncertain_target = 1
      `).run(sessionId, uncertainTarget);

      const id = `ckpt_${Date.now()}_${uuidv4().slice(0, 8)}`;
      db.prepare(`
        INSERT INTO file_checkpoints (
          id, session_id, message_id, file_path, workspace_scope_version,
          original_content, file_existed, uncertain_target, created_at
        )
        VALUES (?, ?, ?, ?, ?, NULL, 0, 1, ?)
      `).run(
        id,
        sessionId,
        messageId,
        uncertainTarget,
        attribution?.workspaceScopeVersion ?? null,
        Date.now(),
      );

      logger.debug('Uncertain write target recorded', { id, sessionId, messageId, uncertainTarget });
      return id;
    } catch (error) {
      logger.error('Failed to record uncertain write target', { error, sessionId, messageId, uncertainTarget });
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
        uncertain_target: number;
      }>;

      if (!checkpoints || checkpoints.length === 0) {
        return result;
      }

      // 按文件路径分组，只保留每个文件最早的检查点（即最原始的状态）
      const fileToOriginal = new Map<string, {
        content: string | null;
        existed: boolean;
        expectedDigest: string | null;
        uncertain: boolean;
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
            uncertain: ckpt.uncertain_target === 1,
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
          if (original.uncertain) {
            // 写目标解析不出来（含通配/变量的重定向等），或建不出无损快照（超大/二进制/
            // 读错误，返修 r2）——没有可安全回退的快照，逐条披露，回退不碰这些文件
            result.skippedFiles.push({
              filePath,
              reason: 'uncertain_write_target',
              detail: 'The write target could not be resolved or safely snapshotted when the tool ran, so no snapshot exists to restore.',
            });
            continue;
          }
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
          AND COALESCE(uncertain_target, 0) = 0
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
      // 上限只数真快照：uncertain 披露行不占预算，大量带变量的重定向不能把
      // 可回退的快照挤出每 session 上限。删除侧同口径（返修 r2 Nit）——最旧的
      // 若是披露行，删它只会白丢披露，真快照数会持续超上限。
      const countResult = db.prepare(`
        SELECT COUNT(*) as cnt FROM file_checkpoints
        WHERE session_id = ? AND COALESCE(uncertain_target, 0) = 0
      `).get(sessionId) as { cnt: number } | undefined;

      const count = countResult?.cnt || 0;
      if (count >= this.config.maxCheckpointsPerSession) {
        // 删除最旧的检查点
        const deleteCount = count - this.config.maxCheckpointsPerSession + 1;
        db.prepare(`
          DELETE FROM file_checkpoints
          WHERE id IN (
            SELECT id FROM file_checkpoints
            WHERE session_id = ? AND COALESCE(uncertain_target, 0) = 0
            ORDER BY created_at ASC, rowid ASC
            LIMIT ?
          )
        `).run(sessionId, deleteCount);

        logger.debug('Enforced checkpoint limit', { sessionId, deleted: deleteCount });
      }

      // 披露行自己的总量上限（返修 r3）：真快照预算不动，但披露也不许无上限增长
      // （同键去重之外，不同键各来一条照样能涨）——超出按最旧淘汰，总量封顶。
      const uncertainResult = db.prepare(`
        SELECT COUNT(*) as cnt FROM file_checkpoints
        WHERE session_id = ? AND uncertain_target = 1
      `).get(sessionId) as { cnt: number } | undefined;

      const uncertainCount = uncertainResult?.cnt || 0;
      if (uncertainCount >= this.config.maxCheckpointsPerSession) {
        const uncertainDeleteCount = uncertainCount - this.config.maxCheckpointsPerSession + 1;
        db.prepare(`
          DELETE FROM file_checkpoints
          WHERE id IN (
            SELECT id FROM file_checkpoints
            WHERE session_id = ? AND uncertain_target = 1
            ORDER BY created_at ASC, rowid ASC
            LIMIT ?
          )
        `).run(sessionId, uncertainDeleteCount);

        logger.debug('Enforced uncertain disclosure limit', { sessionId, deleted: uncertainDeleteCount });
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
