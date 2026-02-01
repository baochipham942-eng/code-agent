// ============================================================================
// Skill Watcher Service - 监听 Skills 目录变化实现热重载
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import { createLogger } from '../infra/logger';
import { getSkillDiscoveryService } from './skillDiscoveryService';

const logger = createLogger('SkillWatcher');

/**
 * Skills 目录变化事件
 */
export interface SkillChangeEvent {
  type: 'add' | 'change' | 'unlink';
  path: string;
  source: 'user' | 'project' | 'library';
}

/**
 * SkillWatcher 配置
 */
export interface SkillWatcherConfig {
  debounceMs?: number;
}

/**
 * Skill 文件监听服务
 *
 * 监听以下目录的变化：
 * - ~/.claude/skills/ (用户级)
 * - .claude/skills/ (项目级)
 * - ~/.code-agent/skills/ (库级)
 *
 * 变化后自动调用 SkillDiscoveryService.reload()
 */
class SkillWatcher extends EventEmitter {
  private watchers: fs.FSWatcher[] = [];
  private workingDirectory = '';
  private debounceMs: number;
  private reloadTimer: NodeJS.Timeout | null = null;
  private initialized = false;

  constructor(config: SkillWatcherConfig = {}) {
    super();
    this.debounceMs = config.debounceMs ?? 500;
  }

  /**
   * 初始化监听器
   */
  async initialize(workingDirectory: string): Promise<void> {
    // 先停止现有的监听器
    this.stop();

    this.workingDirectory = workingDirectory;

    // 用户级 Skills 目录
    const userSkillsDir = path.join(os.homedir(), '.claude', 'skills');
    this.watchDirectory(userSkillsDir, 'user');

    // 库级 Skills 目录
    const librarySkillsDir = path.join(os.homedir(), '.code-agent', 'skills');
    this.watchDirectory(librarySkillsDir, 'library');

    // 项目级 Skills 目录
    const projectSkillsDir = path.join(workingDirectory, '.claude', 'skills');
    this.watchDirectory(projectSkillsDir, 'project');

    this.initialized = true;
    logger.info('SkillWatcher initialized', {
      workingDirectory,
      watchCount: this.watchers.length,
    });
  }

  /**
   * 更新项目目录（工作目录切换时调用）
   */
  async updateProjectDirectory(newWorkingDirectory: string): Promise<void> {
    if (this.workingDirectory === newWorkingDirectory) {
      return;
    }

    logger.info('Updating project directory for SkillWatcher', {
      old: this.workingDirectory,
      new: newWorkingDirectory,
    });

    // 重新初始化
    await this.initialize(newWorkingDirectory);
  }

  /**
   * 监听指定目录
   */
  private watchDirectory(dir: string, source: 'user' | 'project' | 'library'): void {
    // 确保目录存在
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      // 目录可能已存在或无权创建
      logger.debug('Could not create directory', { dir, error: String(error) });
    }

    // 检查目录是否存在且可访问
    try {
      fs.accessSync(dir, fs.constants.R_OK);
    } catch {
      logger.debug('Directory not accessible, skipping watch', { dir });
      return;
    }

    try {
      const watcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;

        // 只关注 SKILL.md 文件或目录变化
        if (filename.endsWith('SKILL.md') || !filename.includes('.')) {
          logger.debug('Skill file changed', { eventType, filename, source });

          const event: SkillChangeEvent = {
            type: eventType === 'rename' ? 'add' : 'change',
            path: path.join(dir, filename),
            source,
          };

          this.emit('change', event);
          this.scheduleReload();
        }
      });

      watcher.on('error', (error) => {
        logger.warn('Watcher error', { dir, error: String(error) });
      });

      this.watchers.push(watcher);
      logger.debug('Watching directory', { dir, source });
    } catch (error) {
      logger.warn('Failed to watch directory', { dir, error: String(error) });
    }
  }

  /**
   * 调度重新加载（带防抖）
   */
  private scheduleReload(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }

    this.reloadTimer = setTimeout(async () => {
      try {
        logger.info('Reloading skills due to file changes');
        const discoveryService = getSkillDiscoveryService();
        await discoveryService.reload();

        const stats = discoveryService.getStats();
        logger.info('Skills reloaded', {
          total: stats.total,
          bySource: stats.bySource,
        });

        this.emit('reloaded', stats);
      } catch (error) {
        logger.error('Failed to reload skills', { error });
        this.emit('error', error);
      }
    }, this.debounceMs);
  }

  /**
   * 停止所有监听器
   */
  stop(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }

    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // 忽略关闭错误
      }
    }

    this.watchers = [];
    this.initialized = false;
    logger.debug('SkillWatcher stopped');
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 获取当前监听的目录数量
   */
  getWatchCount(): number {
    return this.watchers.length;
  }
}

// Global singleton
let globalInstance: SkillWatcher | null = null;

/**
 * 获取全局 SkillWatcher 实例
 */
export function getSkillWatcher(): SkillWatcher {
  if (!globalInstance) {
    globalInstance = new SkillWatcher();
  }
  return globalInstance;
}

/**
 * 初始化 SkillWatcher
 */
export async function initSkillWatcher(workingDirectory: string): Promise<SkillWatcher> {
  const watcher = getSkillWatcher();
  await watcher.initialize(workingDirectory);
  return watcher;
}

/**
 * 重置全局实例（用于测试）
 */
export function resetSkillWatcher(): void {
  if (globalInstance) {
    globalInstance.stop();
    globalInstance = null;
  }
}

export { SkillWatcher };
