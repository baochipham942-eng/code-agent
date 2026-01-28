// ============================================================================
// File Watcher - Watches for file changes with debouncing
// Uses chokidar for efficient cross-platform file watching
// ============================================================================

import path from 'path';
import { EventEmitter } from 'events';
import chokidar, { FSWatcher, type ChokidarOptions } from 'chokidar';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('FileWatcher');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface FileWatchEvent {
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
  filePath: string;
  projectPath: string;
  timestamp: number;
}

export interface FileWatcherConfig {
  debounceMs: number;
  ignorePatterns: string[];
  watchPatterns: string[];
  usePolling: boolean;
  pollInterval: number;
  awaitWriteFinish: boolean | { stabilityThreshold: number; pollInterval: number };
}

export type FileChangeHandler = (events: FileWatchEvent[]) => void | Promise<void>;

// ----------------------------------------------------------------------------
// Debouncer
// ----------------------------------------------------------------------------

class Debouncer {
  private pending: Map<string, FileWatchEvent> = new Map();
  private timer: NodeJS.Timeout | null = null;
  private debounceMs: number;
  private callback: FileChangeHandler;

  constructor(debounceMs: number, callback: FileChangeHandler) {
    this.debounceMs = debounceMs;
    this.callback = callback;
  }

  add(event: FileWatchEvent): void {
    // Merge events for the same file
    const key = event.filePath;
    const existing = this.pending.get(key);

    if (existing) {
      // Prefer unlink over change/add for merged events
      if (event.type === 'unlink' || event.type === 'unlinkDir') {
        this.pending.set(key, event);
      } else if (existing.type !== 'unlink' && existing.type !== 'unlinkDir') {
        // Update timestamp for latest change
        this.pending.set(key, { ...event, timestamp: Date.now() });
      }
    } else {
      this.pending.set(key, event);
    }

    // Reset timer
    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  private async flush(): Promise<void> {
    this.timer = null;
    const events = Array.from(this.pending.values());
    this.pending.clear();

    if (events.length > 0) {
      try {
        await this.callback(events);
      } catch (error) {
        logger.error('Error in file change handler:', error);
      }
    }
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.clear();
  }

  getPendingCount(): number {
    return this.pending.size;
  }
}

// ----------------------------------------------------------------------------
// File Watcher
// ----------------------------------------------------------------------------

export class FileWatcher extends EventEmitter {
  private config: FileWatcherConfig;
  private watchers: Map<string, FSWatcher> = new Map();
  private debouncers: Map<string, Debouncer> = new Map();
  private handlers: Map<string, FileChangeHandler[]> = new Map();

  constructor(config?: Partial<FileWatcherConfig>) {
    super();

    this.config = {
      debounceMs: 500,
      ignorePatterns: [
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/.git/**',
        '**/coverage/**',
        '**/*.log',
        '**/package-lock.json',
        '**/yarn.lock',
        '**/pnpm-lock.yaml',
      ],
      watchPatterns: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.json', '**/*.md'],
      usePolling: false,
      pollInterval: 1000,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
      ...config,
    };
  }

  // --------------------------------------------------------------------------
  // Watch Management
  // --------------------------------------------------------------------------

  /**
   * Start watching a project directory
   */
  watch(
    projectPath: string,
    handler?: FileChangeHandler,
    options?: Partial<ChokidarOptions>
  ): void {
    if (this.watchers.has(projectPath)) {
      logger.warn(`Already watching ${projectPath}`);
      return;
    }

    const watchOptions: ChokidarOptions = {
      ignored: this.config.ignorePatterns,
      persistent: true,
      ignoreInitial: true,
      usePolling: this.config.usePolling,
      interval: this.config.pollInterval,
      awaitWriteFinish: this.config.awaitWriteFinish,
      ...options,
    };

    const watcher = chokidar.watch(projectPath, watchOptions);

    // Set up debouncer
    const debouncer = new Debouncer(this.config.debounceMs, async (events) => {
      // Emit events
      this.emit('change', projectPath, events);

      // Call registered handlers
      const projectHandlers = this.handlers.get(projectPath) || [];
      for (const h of projectHandlers) {
        try {
          await h(events);
        } catch (error) {
          logger.error('Handler error:', error);
        }
      }
    });

    // Wire up chokidar events
    watcher
      .on('add', (filePath) => {
        if (this.shouldProcessFile(filePath)) {
          debouncer.add({
            type: 'add',
            filePath,
            projectPath,
            timestamp: Date.now(),
          });
        }
      })
      .on('change', (filePath) => {
        if (this.shouldProcessFile(filePath)) {
          debouncer.add({
            type: 'change',
            filePath,
            projectPath,
            timestamp: Date.now(),
          });
        }
      })
      .on('unlink', (filePath) => {
        if (this.shouldProcessFile(filePath)) {
          debouncer.add({
            type: 'unlink',
            filePath,
            projectPath,
            timestamp: Date.now(),
          });
        }
      })
      .on('addDir', (filePath) => {
        logger.debug(`Directory added: ${filePath}`);
      })
      .on('unlinkDir', (filePath) => {
        logger.debug(`Directory removed: ${filePath}`);
      })
      .on('error', (error) => {
        logger.error(`Watcher error for ${projectPath}:`, error);
        this.emit('error', projectPath, error);
      })
      .on('ready', () => {
        logger.info(`Watching ${projectPath}`);
        this.emit('ready', projectPath);
      });

    this.watchers.set(projectPath, watcher);
    this.debouncers.set(projectPath, debouncer);

    // Register handler if provided
    if (handler) {
      this.addHandler(projectPath, handler);
    }
  }

  /**
   * Stop watching a project directory
   */
  async unwatch(projectPath: string): Promise<void> {
    const watcher = this.watchers.get(projectPath);
    if (watcher) {
      await watcher.close();
      this.watchers.delete(projectPath);
    }

    const debouncer = this.debouncers.get(projectPath);
    if (debouncer) {
      debouncer.cancel();
      this.debouncers.delete(projectPath);
    }

    this.handlers.delete(projectPath);
    logger.info(`Stopped watching ${projectPath}`);
  }

  /**
   * Stop all watchers
   */
  async unwatchAll(): Promise<void> {
    const paths = Array.from(this.watchers.keys());
    await Promise.all(paths.map((p) => this.unwatch(p)));
  }

  // --------------------------------------------------------------------------
  // Handler Management
  // --------------------------------------------------------------------------

  /**
   * Add a change handler for a project
   */
  addHandler(projectPath: string, handler: FileChangeHandler): void {
    const handlers = this.handlers.get(projectPath) || [];
    handlers.push(handler);
    this.handlers.set(projectPath, handlers);
  }

  /**
   * Remove a change handler for a project
   */
  removeHandler(projectPath: string, handler: FileChangeHandler): void {
    const handlers = this.handlers.get(projectPath);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index !== -1) {
        handlers.splice(index, 1);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Utility Methods
  // --------------------------------------------------------------------------

  /**
   * Check if file should be processed based on patterns
   */
  private shouldProcessFile(filePath: string): boolean {
    const ext = path.extname(filePath);
    const basename = path.basename(filePath);

    // Check watch patterns
    for (const pattern of this.config.watchPatterns) {
      // Simple extension matching
      if (pattern.startsWith('**/*.')) {
        const extPattern = pattern.slice(4); // Remove **/*.
        if (ext === `.${extPattern}`) {
          return true;
        }
      }
      // Exact basename match
      if (basename === pattern) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if watching a path
   */
  isWatching(projectPath: string): boolean {
    return this.watchers.has(projectPath);
  }

  /**
   * Get all watched paths
   */
  getWatchedPaths(): string[] {
    return Array.from(this.watchers.keys());
  }

  /**
   * Get pending event count for a project
   */
  getPendingCount(projectPath: string): number {
    const debouncer = this.debouncers.get(projectPath);
    return debouncer ? debouncer.getPendingCount() : 0;
  }

  /**
   * Get statistics
   */
  getStats(): {
    watchedProjects: number;
    totalPendingEvents: number;
  } {
    let totalPending = 0;
    for (const debouncer of this.debouncers.values()) {
      totalPending += debouncer.getPendingCount();
    }

    return {
      watchedProjects: this.watchers.size,
      totalPendingEvents: totalPending,
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<FileWatcherConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let fileWatcherInstance: FileWatcher | null = null;

export function getFileWatcher(): FileWatcher {
  if (!fileWatcherInstance) {
    fileWatcherInstance = new FileWatcher();
  }
  return fileWatcherInstance;
}

export function createFileWatcher(config?: Partial<FileWatcherConfig>): FileWatcher {
  return new FileWatcher(config);
}
