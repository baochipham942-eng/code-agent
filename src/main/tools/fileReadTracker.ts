// ============================================================================
// File Read Tracker - Track file reads for safe editing
// ============================================================================
// Tracks which files have been read, their mtime at read time, and detects
// external modifications. This enables the edit tool to reject edits on
// unread files and warn about external modifications.
// ============================================================================

import { createHash } from 'crypto';
import fs from 'fs/promises';
import type { EvidenceRef } from '../../shared/contract/evidence';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('FileReadTracker');

export interface FileReadShownRange {
  startLine: number;
  endLine: number;
  totalLines: number;
}

interface FileReadRecord {
  /** Modification time when file was read */
  mtime: number;
  /** Timestamp when the read occurred */
  readTime: number;
  /** File size at read time (for additional verification) */
  size: number;
  /** Short sha256 digest of the file content at read time */
  digest?: string;
  /** ADR-029 read evidence ref produced by the Read tool */
  evidenceRef?: EvidenceRef;
  /** Visible line range that backed the read evidence ref */
  shownRange?: FileReadShownRange;
}

export interface RecordReadOptions {
  digest?: string;
  evidenceRef?: EvidenceRef;
  shownRange?: FileReadShownRange;
}

export function computeContentDigest(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * FileReadTracker - Singleton class to track file reads across the application
 *
 * Key features:
 * - Records file reads with mtime and timestamp
 * - Detects if files have been read before editing
 * - Detects external modifications since last read
 * - Session-scoped (clears on app restart)
 */
class FileReadTracker {
  private static instance: FileReadTracker;
  private readFiles: Map<string, FileReadRecord> = new Map();

  private constructor() {}

  static getInstance(): FileReadTracker {
    if (!FileReadTracker.instance) {
      FileReadTracker.instance = new FileReadTracker();
    }
    return FileReadTracker.instance;
  }

  /**
   * Record that a file has been read
   * @param filePath - Absolute path to the file
   * @param mtime - File's modification time (from fs.stat)
   * @param size - File size in bytes
   */
  recordRead(filePath: string, mtime: number, size: number, options: RecordReadOptions = {}): void {
    this.readFiles.set(filePath, {
      mtime,
      readTime: Date.now(),
      size,
      ...(options.digest ? { digest: options.digest } : {}),
      ...(options.evidenceRef ? { evidenceRef: options.evidenceRef } : {}),
      ...(options.shownRange ? { shownRange: options.shownRange } : {}),
    });
    logger.debug('Recorded file read', { filePath, mtime, size, digest: options.digest });
  }

  /**
   * Record a file read by fetching stats automatically
   * @param filePath - Absolute path to the file
   */
  async recordReadWithStats(filePath: string, options: RecordReadOptions = {}): Promise<void> {
    try {
      const stats = await fs.stat(filePath);
      let digest = options.digest;
      if (!digest) {
        const content = await fs.readFile(filePath);
        digest = computeContentDigest(content);
      }
      this.recordRead(filePath, stats.mtimeMs, stats.size, { ...options, digest });
    } catch (error) {
      logger.warn('Failed to record file read stats', { filePath, error });
    }
  }

  /**
   * Check if a file has been read in the current session
   * @param filePath - Absolute path to the file
   * @returns true if the file has been read
   */
  hasBeenRead(filePath: string): boolean {
    return this.readFiles.has(filePath);
  }

  /**
   * Get the read record for a file
   * @param filePath - Absolute path to the file
   * @returns The read record or undefined
   */
  getReadRecord(filePath: string): FileReadRecord | undefined {
    return this.readFiles.get(filePath);
  }

  /**
   * Check if a file was modified externally since it was last read
   * @param filePath - Absolute path to the file
   * @param currentMtime - Current modification time of the file
   * @returns true if the file was modified externally
   */
  checkExternalModification(filePath: string, currentMtime: number, currentSize?: number, currentDigest?: string): boolean {
    const record = this.readFiles.get(filePath);
    if (!record) {
      // File was never read - can't determine external modification
      return false;
    }
    // Allow 1ms tolerance for filesystem timestamp precision
    const mtimeChanged = Math.abs(currentMtime - record.mtime) > 1;
    const sizeChanged = typeof currentSize === 'number' && currentSize !== record.size;
    const digestChanged = Boolean(record.digest && currentDigest && record.digest !== currentDigest);
    return mtimeChanged || sizeChanged || digestChanged;
  }

  /**
   * Check external modification by fetching current stats
   * @param filePath - Absolute path to the file
   * @returns Object with modification status and details
   */
  async checkExternalModificationWithStats(
    filePath: string
  ): Promise<{
    modified: boolean;
    message?: string;
    originalMtime?: number;
    currentMtime?: number;
    originalDigest?: string;
    currentDigest?: string;
  }> {
    const record = this.readFiles.get(filePath);
    if (!record) {
      return { modified: false };
    }

    try {
      const stats = await fs.stat(filePath);
      const content = await fs.readFile(filePath);
      const currentDigest = computeContentDigest(content);
      const modified = this.checkExternalModification(filePath, stats.mtimeMs, stats.size, currentDigest);

      if (modified) {
        return {
          modified: true,
          message: `File was modified externally since last read`,
          originalMtime: record.mtime,
          currentMtime: stats.mtimeMs,
          originalDigest: record.digest,
          currentDigest,
        };
      }

      return { modified: false };
    } catch (error) {
      logger.warn('Failed to check external modification', { filePath, error });
      return { modified: false };
    }
  }

  /**
   * Update the read record after a successful edit
   * @param filePath - Absolute path to the file
   * @param newMtime - New modification time after edit
   * @param newSize - New file size after edit
   */
  updateAfterEdit(filePath: string, newMtime: number, newSize: number, newDigest?: string): void {
    const record = this.readFiles.get(filePath);
    if (record) {
      record.mtime = newMtime;
      record.size = newSize;
      if (newDigest) {
        record.digest = newDigest;
      }
      logger.debug('Updated file record after edit', { filePath, newMtime, digest: newDigest });
    }
  }

  /**
   * Remove a file from tracking (e.g., after deletion)
   * @param filePath - Absolute path to the file
   */
  removeTracking(filePath: string): void {
    this.readFiles.delete(filePath);
  }

  /**
   * Clear all tracking records (e.g., for testing or session reset)
   */
  clear(): void {
    this.readFiles.clear();
    logger.debug('Cleared all file read tracking records');
  }

  /**
   * Get all tracked files (for debugging)
   * @returns Array of tracked file paths
   */
  getTrackedFiles(): string[] {
    return Array.from(this.readFiles.keys());
  }

  /**
   * Get statistics about tracked files
   */
  getStats(): { totalFiles: number; oldestRead: number | null } {
    const records = Array.from(this.readFiles.values());
    return {
      totalFiles: records.length,
      oldestRead: records.length > 0
        ? Math.min(...records.map(r => r.readTime))
        : null,
    };
  }

  /**
   * 获取最近读取的 N 个文件（按 readTime 降序）
   */
  getRecentFiles(n: number): Array<{ path: string; mtime: number; readTime: number; size: number; digest?: string }> {
    return Array.from(this.readFiles.entries())
      .sort((a, b) => b[1].readTime - a[1].readTime)
      .slice(0, n)
      .map(([path, record]) => ({
        path,
        mtime: record.mtime,
        readTime: record.readTime,
        size: record.size,
        digest: record.digest,
      }));
  }
}

// Export singleton instance
export const fileReadTracker = FileReadTracker.getInstance();

// Export class for testing
export { FileReadTracker };
export type { FileReadRecord };
