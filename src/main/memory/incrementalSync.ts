// ============================================================================
// Incremental Sync Service - Syncs file changes to vector store
// Only re-indexes modified files for efficiency
// ============================================================================

import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { createLogger } from '../services/infra/logger';
import {
  FileTracker,
  initFileTracker,
  type FileChange,
  type TrackedFile,
} from './fileTracker';
import {
  FileWatcher,
  createFileWatcher,
  type FileWatchEvent,
  type FileWatcherConfig,
} from './fileWatcher';
import {
  UnifiedVectorStore,
  initUnifiedVectorStore,
  type UnifiedDocument,
} from './unifiedVectorStore';
import { EmbeddingService, getEmbeddingService } from './embeddingService';

const logger = createLogger('IncrementalSync');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface SyncResult {
  added: number;
  modified: number;
  deleted: number;
  errors: Array<{ filePath: string; error: string }>;
  durationMs: number;
}

export interface SyncProgress {
  phase: 'scanning' | 'indexing' | 'complete';
  total: number;
  processed: number;
  currentFile?: string;
}

export interface IncrementalSyncConfig {
  chunkSize: number; // Characters per chunk
  chunkOverlap: number;
  maxFileSize: number; // Skip files larger than this
  concurrency: number; // Parallel embedding requests
  filePatterns: string[];
  watcherConfig?: Partial<FileWatcherConfig>;
}

// ----------------------------------------------------------------------------
// Text Chunker
// ----------------------------------------------------------------------------

function chunkText(
  text: string,
  chunkSize: number,
  overlap: number
): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));

    // Move start, accounting for overlap
    start = end - overlap;

    // Avoid infinite loop if overlap >= chunkSize
    if (start >= text.length - overlap) break;
  }

  return chunks;
}

// ----------------------------------------------------------------------------
// Incremental Sync Service
// ----------------------------------------------------------------------------

export class IncrementalSyncService extends EventEmitter {
  private config: IncrementalSyncConfig;
  private fileTracker: FileTracker | null = null;
  private fileWatcher: FileWatcher | null = null;
  private vectorStore: UnifiedVectorStore | null = null;
  private embeddingService: EmbeddingService;
  private initialized = false;
  private syncing = false;
  private watchedProjects: Set<string> = new Set();

  constructor(config?: Partial<IncrementalSyncConfig>) {
    super();

    this.config = {
      chunkSize: 1000,
      chunkOverlap: 100,
      maxFileSize: 1024 * 1024, // 1MB
      concurrency: 3,
      filePatterns: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.md'],
      ...config,
    };

    this.embeddingService = getEmbeddingService();
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Initialize components
      this.fileTracker = await initFileTracker();
      this.vectorStore = await initUnifiedVectorStore({ mode: 'hybrid' });
      this.fileWatcher = createFileWatcher(this.config.watcherConfig);

      this.initialized = true;
      logger.info('IncrementalSyncService initialized');
    } catch (error) {
      logger.error('Failed to initialize IncrementalSyncService:', error);
      throw error;
    }
  }

  // --------------------------------------------------------------------------
  // Sync Operations
  // --------------------------------------------------------------------------

  /**
   * Perform full sync for a project (initial indexing)
   */
  async fullSync(projectPath: string): Promise<SyncResult> {
    if (!this.initialized) await this.initialize();
    if (!this.fileTracker || !this.vectorStore) {
      throw new Error('Service not initialized');
    }

    const startTime = Date.now();
    const result: SyncResult = {
      added: 0,
      modified: 0,
      deleted: 0,
      errors: [],
      durationMs: 0,
    };

    try {
      this.syncing = true;
      this.emit('syncStart', projectPath);

      // Find all files to index
      const { glob } = await import('glob');
      const allFiles: string[] = [];

      for (const pattern of this.config.filePatterns) {
        const files = await glob(pattern, {
          cwd: projectPath,
          absolute: true,
          ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**'],
        });
        allFiles.push(...files);
      }

      // Remove duplicates
      const uniqueFiles = [...new Set(allFiles)];

      logger.info(`Full sync: ${uniqueFiles.length} files found in ${projectPath}`);

      // Process files in batches
      const total = uniqueFiles.length;
      let processed = 0;

      for (const filePath of uniqueFiles) {
        this.emit('progress', {
          phase: 'indexing',
          total,
          processed,
          currentFile: filePath,
        } as SyncProgress);

        try {
          const stats = fs.statSync(filePath);

          // Skip large files
          if (stats.size > this.config.maxFileSize) {
            logger.debug(`Skipping large file: ${filePath}`);
            continue;
          }

          await this.indexFile(filePath, projectPath);
          result.added++;
        } catch (error) {
          result.errors.push({
            filePath,
            error: (error as Error).message,
          });
        }

        processed++;
      }

      result.durationMs = Date.now() - startTime;
      this.emit('syncComplete', projectPath, result);

      logger.info(
        `Full sync complete: ${result.added} added, ${result.errors.length} errors, ${result.durationMs}ms`
      );

      return result;
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Perform incremental sync (only changed files)
   */
  async incrementalSync(projectPath: string): Promise<SyncResult> {
    if (!this.initialized) await this.initialize();
    if (!this.fileTracker || !this.vectorStore) {
      throw new Error('Service not initialized');
    }

    const startTime = Date.now();
    const result: SyncResult = {
      added: 0,
      modified: 0,
      deleted: 0,
      errors: [],
      durationMs: 0,
    };

    try {
      this.syncing = true;
      this.emit('syncStart', projectPath);

      // Detect changes
      const changes = await this.fileTracker.detectChangesInProject(
        projectPath,
        this.config.filePatterns
      );

      logger.info(`Incremental sync: ${changes.length} changes detected`);

      if (changes.length === 0) {
        result.durationMs = Date.now() - startTime;
        this.emit('syncComplete', projectPath, result);
        return result;
      }

      // Process changes
      const total = changes.length;
      let processed = 0;

      for (const change of changes) {
        this.emit('progress', {
          phase: 'indexing',
          total,
          processed,
          currentFile: change.filePath,
        } as SyncProgress);

        try {
          await this.processChange(change);

          switch (change.changeType) {
            case 'added':
              result.added++;
              break;
            case 'modified':
              result.modified++;
              break;
            case 'deleted':
              result.deleted++;
              break;
          }
        } catch (error) {
          result.errors.push({
            filePath: change.filePath,
            error: (error as Error).message,
          });
        }

        processed++;
      }

      result.durationMs = Date.now() - startTime;
      this.emit('syncComplete', projectPath, result);

      logger.info(
        `Incremental sync complete: +${result.added} ~${result.modified} -${result.deleted}, ${result.errors.length} errors, ${result.durationMs}ms`
      );

      return result;
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Process a single file change
   */
  private async processChange(change: FileChange): Promise<void> {
    if (!this.fileTracker || !this.vectorStore) {
      throw new Error('Service not initialized');
    }

    switch (change.changeType) {
      case 'added':
      case 'modified': {
        await this.indexFile(change.filePath, change.projectPath);
        break;
      }

      case 'deleted': {
        // Remove from vector store
        this.vectorStore.deleteByFilter({
          filePath: change.filePath,
        });

        // Remove from tracker
        this.fileTracker.untrack(change.filePath);
        break;
      }
    }
  }

  /**
   * Index a single file
   */
  private async indexFile(filePath: string, projectPath?: string): Promise<void> {
    if (!this.fileTracker || !this.vectorStore) {
      throw new Error('Service not initialized');
    }

    // Read file content
    const content = fs.readFileSync(filePath, 'utf-8');
    const stats = fs.statSync(filePath);

    // Compute content hash
    const contentHash = this.fileTracker.computeHashFromContent(content);

    // Check if already indexed with same hash
    if (this.vectorStore.existsByHash(contentHash)) {
      // Update tracker timestamp only
      this.fileTracker.trackWithHash(filePath, contentHash, stats, projectPath);
      return;
    }

    // Delete existing chunks for this file
    this.vectorStore.deleteByFilter({ filePath });

    // Chunk the content
    const chunks = chunkText(content, this.config.chunkSize, this.config.chunkOverlap);

    // Generate embeddings and store
    const documents: UnifiedDocument[] = chunks.map((chunk, index) => ({
      id: `${contentHash}_chunk_${index}`,
      content: chunk,
      metadata: {
        source: 'file',
        projectPath,
        filePath,
        contentHash,
        chunkIndex: index,
        totalChunks: chunks.length,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    }));

    // Batch upsert
    await this.vectorStore.upsertBatch(documents);

    // Update tracker
    this.fileTracker.trackWithHash(filePath, contentHash, stats, projectPath);

    logger.debug(`Indexed ${filePath}: ${chunks.length} chunks`);
  }

  // --------------------------------------------------------------------------
  // Watch Operations
  // --------------------------------------------------------------------------

  /**
   * Start watching a project for changes
   */
  startWatching(projectPath: string): void {
    if (!this.initialized || !this.fileWatcher) {
      throw new Error('Service not initialized');
    }

    if (this.watchedProjects.has(projectPath)) {
      logger.warn(`Already watching ${projectPath}`);
      return;
    }

    // Set up file change handler
    const handler = async (events: FileWatchEvent[]) => {
      if (this.syncing) {
        logger.debug('Sync in progress, skipping events');
        return;
      }

      // Convert watch events to file changes
      const changes: FileChange[] = events.map((e) => ({
        filePath: e.filePath,
        changeType: e.type === 'add' ? 'added' : e.type === 'change' ? 'modified' : 'deleted',
        projectPath: e.projectPath,
      }));

      // Process changes
      for (const change of changes) {
        try {
          await this.processChange(change);
          this.emit('fileChanged', change);
        } catch (error) {
          logger.error(`Error processing change for ${change.filePath}:`, error);
        }
      }
    };

    this.fileWatcher.watch(projectPath, handler);
    this.watchedProjects.add(projectPath);

    logger.info(`Started watching ${projectPath}`);
  }

  /**
   * Stop watching a project
   */
  async stopWatching(projectPath: string): Promise<void> {
    if (!this.fileWatcher) return;

    await this.fileWatcher.unwatch(projectPath);
    this.watchedProjects.delete(projectPath);

    logger.info(`Stopped watching ${projectPath}`);
  }

  /**
   * Stop watching all projects
   */
  async stopWatchingAll(): Promise<void> {
    if (!this.fileWatcher) return;

    await this.fileWatcher.unwatchAll();
    this.watchedProjects.clear();

    logger.info('Stopped watching all projects');
  }

  // --------------------------------------------------------------------------
  // Query Methods
  // --------------------------------------------------------------------------

  /**
   * Search for relevant code
   */
  async search(
    query: string,
    projectPath?: string,
    topK: number = 10
  ): Promise<Array<{
    content: string;
    filePath?: string;
    score: number;
    chunkIndex?: number;
  }>> {
    if (!this.vectorStore) {
      throw new Error('Service not initialized');
    }

    const results = await this.vectorStore.searchCode(query, projectPath, topK);

    return results.map((r) => ({
      content: r.content,
      filePath: r.metadata.filePath,
      score: r.score,
      chunkIndex: r.metadata.chunkIndex as number | undefined,
    }));
  }

  // --------------------------------------------------------------------------
  // Utility Methods
  // --------------------------------------------------------------------------

  /**
   * Get sync status
   */
  getStatus(): {
    initialized: boolean;
    syncing: boolean;
    watchedProjects: string[];
    trackedFiles: number;
    vectorStoreStats: ReturnType<UnifiedVectorStore['getStats']> | null;
  } {
    return {
      initialized: this.initialized,
      syncing: this.syncing,
      watchedProjects: Array.from(this.watchedProjects),
      trackedFiles: this.fileTracker?.getTrackedCount() || 0,
      vectorStoreStats: this.vectorStore?.getStats() || null,
    };
  }

  /**
   * Clear all indexed data for a project
   */
  async clearProject(projectPath: string): Promise<void> {
    if (this.fileTracker) {
      this.fileTracker.untrackProject(projectPath);
    }

    if (this.vectorStore) {
      this.vectorStore.deleteByFilter({ projectPath });
    }

    logger.info(`Cleared all data for ${projectPath}`);
  }

  /**
   * Close and cleanup
   */
  async close(): Promise<void> {
    await this.stopWatchingAll();

    if (this.vectorStore) {
      this.vectorStore.close();
    }

    if (this.fileTracker) {
      this.fileTracker.close();
    }

    this.initialized = false;
    logger.info('IncrementalSyncService closed');
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let incrementalSyncInstance: IncrementalSyncService | null = null;

export function getIncrementalSyncService(): IncrementalSyncService {
  if (!incrementalSyncInstance) {
    incrementalSyncInstance = new IncrementalSyncService();
  }
  return incrementalSyncInstance;
}

export async function initIncrementalSyncService(
  config?: Partial<IncrementalSyncConfig>
): Promise<IncrementalSyncService> {
  if (config) {
    incrementalSyncInstance = new IncrementalSyncService(config);
  } else {
    incrementalSyncInstance = getIncrementalSyncService();
  }
  await incrementalSyncInstance.initialize();
  return incrementalSyncInstance;
}
