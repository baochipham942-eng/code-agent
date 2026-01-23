// ============================================================================
// File Read Tracker - Track file reads for safe editing
// ============================================================================
// Tracks which files have been read, their mtime at read time, and detects
// external modifications. This enables the edit tool to reject edits on
// unread files and warn about external modifications.
// ============================================================================

import fs from 'fs/promises';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('FileReadTracker');

interface FileReadRecord {
  /** Modification time when file was read */
  mtime: number;
  /** Timestamp when the read occurred */
  readTime: number;
  /** File size at read time (for additional verification) */
  size: number;
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
  recordRead(filePath: string, mtime: number, size: number): void {
    this.readFiles.set(filePath, {
      mtime,
      readTime: Date.now(),
      size,
    });
    logger.debug('Recorded file read', { filePath, mtime, size });
  }

  /**
   * Record a file read by fetching stats automatically
   * @param filePath - Absolute path to the file
   */
  async recordReadWithStats(filePath: string): Promise<void> {
    try {
      const stats = await fs.stat(filePath);
      this.recordRead(filePath, stats.mtimeMs, stats.size);
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
  checkExternalModification(filePath: string, currentMtime: number): boolean {
    const record = this.readFiles.get(filePath);
    if (!record) {
      // File was never read - can't determine external modification
      return false;
    }
    // Allow 1ms tolerance for filesystem timestamp precision
    return Math.abs(currentMtime - record.mtime) > 1;
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
  }> {
    const record = this.readFiles.get(filePath);
    if (!record) {
      return { modified: false };
    }

    try {
      const stats = await fs.stat(filePath);
      const modified = Math.abs(stats.mtimeMs - record.mtime) > 1;

      if (modified) {
        return {
          modified: true,
          message: `File was modified externally since last read`,
          originalMtime: record.mtime,
          currentMtime: stats.mtimeMs,
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
  updateAfterEdit(filePath: string, newMtime: number, newSize: number): void {
    const record = this.readFiles.get(filePath);
    if (record) {
      record.mtime = newMtime;
      record.size = newSize;
      logger.debug('Updated file record after edit', { filePath, newMtime });
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
}

// Export singleton instance
export const fileReadTracker = FileReadTracker.getInstance();

// Export class for testing
export { FileReadTracker };
export type { FileReadRecord };
