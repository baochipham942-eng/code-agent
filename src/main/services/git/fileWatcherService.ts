// ============================================================================
// File Watcher Service - 监听工作区文件变更
// ============================================================================
// 检测工作区文件被外部（IDE、用户手动）修改，通知 Agent 上下文
// 使用 chokidar 监听，避免基于过时文件内容操作

import { createLogger } from '../infra/logger';

const logger = createLogger('FileWatcherService');

// 忽略的目录和文件
const IGNORED_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/target/**',
  '**/.DS_Store',
  '**/*.swp',
  '**/*.swo',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
];

import type { FileChangeEvent } from '../../protocol/types/git';
export type { FileChangeEvent };

type FileChangeListener = (event: FileChangeEvent) => void;

class FileWatcherService {
  private watcher: ReturnType<typeof import('chokidar')['watch']> | null = null;
  private watchedDir: string | null = null;
  private listeners: FileChangeListener[] = [];
  private recentChanges: FileChangeEvent[] = [];
  private agentModifiedFiles = new Set<string>();
  private static readonly MAX_RECENT = 50;

  /**
   * 开始监听指定工作目录
   */
  async watch(directory: string): Promise<void> {
    // 如果已在监听相同目录，跳过
    if (this.watchedDir === directory && this.watcher) return;

    // 关闭之前的监听
    await this.stop();

    try {
      const chokidar = await import('chokidar');
      this.watcher = chokidar.watch(directory, {
        ignored: IGNORED_PATTERNS,
        ignoreInitial: true,
        persistent: true,
        awaitWriteFinish: {
          stabilityThreshold: 300,
          pollInterval: 100,
        },
        depth: 5,
      });

      this.watchedDir = directory;

      this.watcher.on('change', (filePath: string) => {
        this.handleChange('change', filePath);
      });

      this.watcher.on('add', (filePath: string) => {
        this.handleChange('add', filePath);
      });

      this.watcher.on('unlink', (filePath: string) => {
        this.handleChange('unlink', filePath);
      });

      this.watcher.on('error', (error: unknown) => {
        logger.error('File watcher error', { error: String(error) });
      });

      logger.info('File watcher started', { directory });
    } catch (error) {
      logger.error('Failed to start file watcher', { error });
    }
  }

  /**
   * 标记文件为 Agent 修改（避免误报）
   */
  markAsAgentModified(filePath: string): void {
    this.agentModifiedFiles.add(filePath);
    // 5 秒后清除标记（给文件系统事件时间到达）
    setTimeout(() => {
      this.agentModifiedFiles.delete(filePath);
    }, 5000);
  }

  /**
   * 获取自上次检查以来的外部变更
   */
  getRecentExternalChanges(): FileChangeEvent[] {
    const changes = [...this.recentChanges];
    this.recentChanges = [];
    return changes;
  }

  /**
   * 检查是否有未处理的外部变更
   */
  hasExternalChanges(): boolean {
    return this.recentChanges.length > 0;
  }

  /**
   * 添加变更监听器
   */
  addListener(listener: FileChangeListener): void {
    this.listeners.push(listener);
  }

  /**
   * 移除变更监听器
   */
  removeListener(listener: FileChangeListener): void {
    this.listeners = this.listeners.filter(l => l !== listener);
  }

  /**
   * 停止监听
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      this.watchedDir = null;
      logger.info('File watcher stopped');
    }
  }

  private handleChange(type: 'add' | 'change' | 'unlink', filePath: string): void {
    // 过滤 Agent 自己的修改
    if (this.agentModifiedFiles.has(filePath)) {
      return;
    }

    const event: FileChangeEvent = {
      type,
      path: filePath,
      timestamp: Date.now(),
    };

    // 存储近期变更
    this.recentChanges.push(event);
    if (this.recentChanges.length > FileWatcherService.MAX_RECENT) {
      this.recentChanges = this.recentChanges.slice(-FileWatcherService.MAX_RECENT);
    }

    // 通知监听器
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        logger.error('File change listener error', { error });
      }
    }
  }
}

// Singleton
let instance: FileWatcherService | null = null;

export function getFileWatcherService(): FileWatcherService {
  if (!instance) {
    instance = new FileWatcherService();
  }
  return instance;
}
