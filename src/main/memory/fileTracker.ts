// ============================================================================
// File Tracker - Tracks file hashes for incremental sync
// Detects file changes by comparing content hashes
// ============================================================================

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { app } from 'electron';
// 延迟加载 better-sqlite3，CLI 模式下原生模块 ABI 不匹配
import type BetterSqlite3 from 'better-sqlite3';
let Database: typeof BetterSqlite3 | null = null;
if (!process.env.CODE_AGENT_CLI_MODE) {
  try {
    Database = require('better-sqlite3');
  } catch (error) {
    console.warn('[FileTracker] better-sqlite3 not available:', (error as Error).message?.split('\n')[0]);
  }
}
import { createLogger } from '../services/infra/logger';

const logger = createLogger('FileTracker');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface TrackedFile {
  filePath: string;
  contentHash: string;
  size: number;
  mtime: number;
  indexedAt: number;
  projectPath?: string;
}

export interface FileChange {
  filePath: string;
  changeType: 'added' | 'modified' | 'deleted';
  oldHash?: string;
  newHash?: string;
  projectPath?: string;
}

export interface FileTrackerConfig {
  dbPath: string;
  hashAlgorithm: 'md5' | 'sha1' | 'sha256';
}

// ----------------------------------------------------------------------------
// File Tracker
// ----------------------------------------------------------------------------

export class FileTracker {
  private db: BetterSqlite3.Database | null = null;
  private config: FileTrackerConfig;
  private initialized = false;

  constructor(config?: Partial<FileTrackerConfig>) {
    const userDataPath = app?.getPath?.('userData') || process.cwd();

    this.config = {
      dbPath: path.join(userDataPath, 'file-tracker.db'),
      hashAlgorithm: 'md5', // Fast hash for change detection
      ...config,
    };
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const dir = path.dirname(this.config.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (!Database) {
        throw new Error('better-sqlite3 not available (CLI mode or native module missing)');
      }
      this.db = new Database(this.config.dbPath);
      this.createTables();
      this.initialized = true;

      logger.info(`FileTracker initialized at ${this.config.dbPath}`);
    } catch (error) {
      logger.error('Failed to initialize FileTracker:', error);
      throw error;
    }
  }

  private createTables(): void {
    if (!this.db) throw new Error('Database not initialized');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tracked_files (
        file_path TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL,
        project_path TEXT
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tracked_files_project ON tracked_files(project_path)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tracked_files_hash ON tracked_files(content_hash)
    `);
  }

  // --------------------------------------------------------------------------
  // Hash Computation
  // --------------------------------------------------------------------------

  /**
   * Compute content hash for a file
   */
  computeHash(filePath: string): string {
    try {
      const content = fs.readFileSync(filePath);
      return crypto.createHash(this.config.hashAlgorithm).update(content).digest('hex');
    } catch (error) {
      logger.error(`Failed to compute hash for ${filePath}:`, error);
      throw error;
    }
  }

  /**
   * Compute hash from content string
   */
  computeHashFromContent(content: string): string {
    return crypto.createHash(this.config.hashAlgorithm).update(content).digest('hex');
  }

  /**
   * Quick stat-based change detection (without reading file content)
   */
  hasFileStatChanged(filePath: string): boolean {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const stats = fs.statSync(filePath);
      const tracked = this.getTrackedFile(filePath);

      if (!tracked) return true; // New file

      // Check if mtime or size changed
      return (
        stats.mtimeMs !== tracked.mtime ||
        stats.size !== tracked.size
      );
    } catch {
      return true; // File doesn't exist or error
    }
  }

  // --------------------------------------------------------------------------
  // Tracking Operations
  // --------------------------------------------------------------------------

  /**
   * Start tracking a file
   */
  track(filePath: string, projectPath?: string): TrackedFile {
    if (!this.db) throw new Error('Database not initialized');

    const stats = fs.statSync(filePath);
    const contentHash = this.computeHash(filePath);
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO tracked_files (file_path, content_hash, size, mtime, indexed_at, project_path)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        content_hash = excluded.content_hash,
        size = excluded.size,
        mtime = excluded.mtime,
        indexed_at = excluded.indexed_at,
        project_path = excluded.project_path
    `).run(filePath, contentHash, stats.size, stats.mtimeMs, now, projectPath || null);

    return {
      filePath,
      contentHash,
      size: stats.size,
      mtime: stats.mtimeMs,
      indexedAt: now,
      projectPath,
    };
  }

  /**
   * Track a file with pre-computed hash (avoids double read)
   */
  trackWithHash(
    filePath: string,
    contentHash: string,
    stats: fs.Stats,
    projectPath?: string
  ): TrackedFile {
    if (!this.db) throw new Error('Database not initialized');

    const now = Date.now();

    this.db.prepare(`
      INSERT INTO tracked_files (file_path, content_hash, size, mtime, indexed_at, project_path)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        content_hash = excluded.content_hash,
        size = excluded.size,
        mtime = excluded.mtime,
        indexed_at = excluded.indexed_at,
        project_path = excluded.project_path
    `).run(filePath, contentHash, stats.size, stats.mtimeMs, now, projectPath || null);

    return {
      filePath,
      contentHash,
      size: stats.size,
      mtime: stats.mtimeMs,
      indexedAt: now,
      projectPath,
    };
  }

  /**
   * Stop tracking a file
   */
  untrack(filePath: string): boolean {
    if (!this.db) throw new Error('Database not initialized');

    const result = this.db.prepare('DELETE FROM tracked_files WHERE file_path = ?').run(filePath);
    return result.changes > 0;
  }

  /**
   * Stop tracking all files in a project
   */
  untrackProject(projectPath: string): number {
    if (!this.db) throw new Error('Database not initialized');

    const result = this.db
      .prepare('DELETE FROM tracked_files WHERE project_path = ?')
      .run(projectPath);
    return result.changes;
  }

  /**
   * Get tracked file info
   */
  getTrackedFile(filePath: string): TrackedFile | null {
    if (!this.db) throw new Error('Database not initialized');

    const row = this.db
      .prepare('SELECT * FROM tracked_files WHERE file_path = ?')
      .get(filePath) as {
        file_path: string;
        content_hash: string;
        size: number;
        mtime: number;
        indexed_at: number;
        project_path: string | null;
      } | undefined;

    if (!row) return null;

    return {
      filePath: row.file_path,
      contentHash: row.content_hash,
      size: row.size,
      mtime: row.mtime,
      indexedAt: row.indexed_at,
      projectPath: row.project_path || undefined,
    };
  }

  /**
   * Get all tracked files for a project
   */
  getTrackedFilesForProject(projectPath: string): TrackedFile[] {
    if (!this.db) throw new Error('Database not initialized');

    const rows = this.db
      .prepare('SELECT * FROM tracked_files WHERE project_path = ?')
      .all(projectPath) as Array<{
        file_path: string;
        content_hash: string;
        size: number;
        mtime: number;
        indexed_at: number;
        project_path: string | null;
      }>;

    return rows.map((row) => ({
      filePath: row.file_path,
      contentHash: row.content_hash,
      size: row.size,
      mtime: row.mtime,
      indexedAt: row.indexed_at,
      projectPath: row.project_path || undefined,
    }));
  }

  // --------------------------------------------------------------------------
  // Change Detection
  // --------------------------------------------------------------------------

  /**
   * Detect changes for a single file
   */
  detectChange(filePath: string, projectPath?: string): FileChange | null {
    const tracked = this.getTrackedFile(filePath);

    // Check if file exists
    const exists = fs.existsSync(filePath);

    if (!tracked && exists) {
      // New file
      return {
        filePath,
        changeType: 'added',
        newHash: this.computeHash(filePath),
        projectPath,
      };
    }

    if (tracked && !exists) {
      // Deleted file
      return {
        filePath,
        changeType: 'deleted',
        oldHash: tracked.contentHash,
        projectPath: tracked.projectPath,
      };
    }

    if (tracked && exists) {
      // Check for modification
      const stats = fs.statSync(filePath);

      // Quick check: if mtime and size unchanged, probably unchanged
      if (stats.mtimeMs === tracked.mtime && stats.size === tracked.size) {
        return null;
      }

      // Compute new hash to confirm
      const newHash = this.computeHash(filePath);
      if (newHash !== tracked.contentHash) {
        return {
          filePath,
          changeType: 'modified',
          oldHash: tracked.contentHash,
          newHash,
          projectPath: tracked.projectPath,
        };
      }
    }

    return null;
  }

  /**
   * Detect all changes in a project directory
   */
  async detectChangesInProject(
    projectPath: string,
    filePatterns: string[] = ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx']
  ): Promise<FileChange[]> {
    const changes: FileChange[] = [];
    const trackedFiles = this.getTrackedFilesForProject(projectPath);
    const trackedPaths = new Set(trackedFiles.map((f) => f.filePath));
    const seenPaths = new Set<string>();

    // Find current files matching patterns
    const { glob } = await import('glob');
    for (const pattern of filePatterns) {
      const files = await glob(pattern, {
        cwd: projectPath,
        absolute: true,
        ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**'],
      });

      for (const filePath of files) {
        seenPaths.add(filePath);

        const change = this.detectChange(filePath, projectPath);
        if (change) {
          changes.push(change);
        }
      }
    }

    // Find deleted files (tracked but no longer exist)
    for (const tracked of trackedFiles) {
      if (!seenPaths.has(tracked.filePath)) {
        if (!fs.existsSync(tracked.filePath)) {
          changes.push({
            filePath: tracked.filePath,
            changeType: 'deleted',
            oldHash: tracked.contentHash,
            projectPath: tracked.projectPath,
          });
        }
      }
    }

    return changes;
  }

  // --------------------------------------------------------------------------
  // Utility Methods
  // --------------------------------------------------------------------------

  /**
   * Get count of tracked files
   */
  getTrackedCount(projectPath?: string): number {
    if (!this.db) throw new Error('Database not initialized');

    if (projectPath) {
      const row = this.db
        .prepare('SELECT COUNT(*) as count FROM tracked_files WHERE project_path = ?')
        .get(projectPath) as { count: number };
      return row.count;
    }

    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM tracked_files')
      .get() as { count: number };
    return row.count;
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalFiles: number;
    byProject: Record<string, number>;
    totalSize: number;
  } {
    if (!this.db) throw new Error('Database not initialized');

    const totalRow = this.db
      .prepare('SELECT COUNT(*) as count, SUM(size) as total_size FROM tracked_files')
      .get() as { count: number; total_size: number | null };

    const projectRows = this.db
      .prepare(
        'SELECT project_path, COUNT(*) as count FROM tracked_files WHERE project_path IS NOT NULL GROUP BY project_path'
      )
      .all() as Array<{ project_path: string; count: number }>;

    const byProject: Record<string, number> = {};
    for (const row of projectRows) {
      byProject[row.project_path] = row.count;
    }

    return {
      totalFiles: totalRow.count,
      byProject,
      totalSize: totalRow.total_size || 0,
    };
  }

  /**
   * Clear all tracking data
   */
  clear(): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.exec('DELETE FROM tracked_files');
  }

  /**
   * Close database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
    }
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let fileTrackerInstance: FileTracker | null = null;

export function getFileTracker(): FileTracker {
  if (!fileTrackerInstance) {
    fileTrackerInstance = new FileTracker();
  }
  return fileTrackerInstance;
}

export async function initFileTracker(
  config?: Partial<FileTrackerConfig>
): Promise<FileTracker> {
  if (config) {
    fileTrackerInstance = new FileTracker(config);
  } else {
    fileTrackerInstance = getFileTracker();
  }
  await fileTrackerInstance.initialize();
  return fileTrackerInstance;
}
