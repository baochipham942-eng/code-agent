// ============================================================================
// Heartbeat Task Loader - HEARTBEAT.md 自驱动任务
// ============================================================================
// 从 .code-agent/HEARTBEAT.md 中解析自然语言定义的定时任务
// 自动注册到 CronService，支持 active_hours 窗口和 channel 推送
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../services/infra/logger';
import { getProjectConfigDir } from '../config/configPaths';
const logger = createLogger('HeartbeatTaskLoader');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/** Minimal CronService interface (avoids circular dep with cronService.ts) */
interface CronServiceLike {
  scheduleCron(cron: string, action: unknown, options: unknown): Promise<{ id: string }>;
  deleteJob(jobId: string): Promise<boolean>;
}

interface HeartbeatTask {
  name: string;
  cron: string;
  prompt: string;
  channel?: string;
  activeHours?: string;  // "HH:MM-HH:MM"
  enabled: boolean;
}

interface HeartbeatTaskLoaderConfig {
  workingDirectory: string;
  cronService: CronServiceLike;
}

// ----------------------------------------------------------------------------
// HeartbeatTaskLoader
// ----------------------------------------------------------------------------

export class HeartbeatTaskLoader {
  private config: HeartbeatTaskLoaderConfig;
  private registeredJobIds: Set<string> = new Set();
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: HeartbeatTaskLoaderConfig) {
    this.config = config;
  }

  /**
   * 加载 HEARTBEAT.md 并注册任务
   */
  async loadFromFile(): Promise<void> {
    const filePath = this.getHeartbeatPath();

    if (!fs.existsSync(filePath)) {
      logger.info('No HEARTBEAT.md found', { path: filePath });
      return;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const tasks = this.parseHeartbeatMd(content);

      // 清除旧的 heartbeat jobs
      await this.cleanup();

      // 注册新任务
      for (const task of tasks) {
        if (!task.enabled) continue;

        try {
          const job = await this.config.cronService.scheduleCron(
            task.cron,
            {
              type: 'agent',
              agentType: 'heartbeat',
              prompt: task.prompt,
              context: {
                channel: task.channel,
                activeHours: task.activeHours,
                heartbeatTask: true,
              },
            },
            {
              name: `[Heartbeat] ${task.name}`,
              description: `Auto-loaded from HEARTBEAT.md: ${task.name}`,
            }
          );

          this.registeredJobIds.add(job.id);
          logger.info('Registered heartbeat task', { name: task.name, cron: task.cron, jobId: job.id });
        } catch (error) {
          logger.error('Failed to register heartbeat task', { name: task.name, error: String(error) });
        }
      }

      logger.info('Heartbeat tasks loaded', { total: tasks.length, registered: this.registeredJobIds.size });
    } catch (error) {
      logger.error('Failed to load HEARTBEAT.md', { error: String(error) });
    }
  }

  /**
   * 监听文件变更，自动重新加载
   */
  watchFile(): void {
    this.unwatchFile();

    const dir = path.dirname(this.getHeartbeatPath());
    if (!fs.existsSync(dir)) return;

    try {
      this.watcher = fs.watch(dir, (eventType, filename) => {
        if (filename === 'HEARTBEAT.md') {
          if (this.debounceTimer) clearTimeout(this.debounceTimer);
          this.debounceTimer = setTimeout(() => {
            logger.info('HEARTBEAT.md changed, reloading tasks');
            this.loadFromFile().catch(err => {
              logger.error('Failed to reload HEARTBEAT.md', { error: String(err) });
            });
          }, 500);
        }
      });
    } catch (error) {
      logger.warn('Failed to watch HEARTBEAT.md directory', { error: String(error) });
    }
  }

  /**
   * 清除所有已注册的 heartbeat jobs
   */
  async cleanup(): Promise<void> {
    for (const jobId of this.registeredJobIds) {
      try {
        await this.config.cronService.deleteJob(jobId);
      } catch (error) {
        logger.warn('Failed to delete heartbeat job', { jobId, error: String(error) });
      }
    }
    this.registeredJobIds.clear();
  }

  /**
   * 停止文件监听
   */
  private unwatchFile(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  // --------------------------------------------------------------------------
  // Parsing
  // --------------------------------------------------------------------------

  /**
   * 解析 HEARTBEAT.md 内容
   *
   * 格式示例:
   * ```
   * ### 每日代码检查
   * - cron: 0 9 * * 1-5
   * - prompt: 运行 npm run typecheck，如有错误则汇总报告
   * - channel: feishu
   * - active_hours: 08:00-18:00
   * - enabled: true
   * ```
   */
  private parseHeartbeatMd(content: string): HeartbeatTask[] {
    const tasks: HeartbeatTask[] = [];
    const blocks = content.split(/^###\s+/m).filter(Boolean);

    for (const block of blocks) {
      const lines = block.split('\n');
      const name = lines[0]?.trim();
      if (!name) continue;

      const task: HeartbeatTask = {
        name,
        cron: '',
        prompt: '',
        enabled: true,
      };

      for (const line of lines.slice(1)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('-')) continue;

        const match = trimmed.match(/^-\s*(\w+(?:_\w+)*):\s*(.+)$/);
        if (!match) continue;

        const [, key, value] = match;
        switch (key) {
          case 'cron':
            task.cron = value.trim();
            break;
          case 'prompt':
            task.prompt = value.trim();
            break;
          case 'channel':
            task.channel = value.trim();
            break;
          case 'active_hours':
            task.activeHours = value.trim();
            break;
          case 'enabled':
            task.enabled = value.trim().toLowerCase() !== 'false';
            break;
        }
      }

      // 验证必要字段
      if (task.cron && task.prompt) {
        tasks.push(task);
      } else {
        logger.warn('Skipping incomplete heartbeat task', { name, hasCron: !!task.cron, hasPrompt: !!task.prompt });
      }
    }

    return tasks;
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private getHeartbeatPath(): string {
    return path.join(getProjectConfigDir(this.config.workingDirectory), 'HEARTBEAT.md');
  }
}

// ----------------------------------------------------------------------------
// Active Hours Check (used by CronService when executing heartbeat actions)
// ----------------------------------------------------------------------------

/**
 * 检查当前时间是否在 active_hours 窗口内
 */
export function isWithinActiveHours(activeHours?: string): boolean {
  if (!activeHours) return true;

  const match = activeHours.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
  if (!match) return true;

  const [, startH, startM, endH, endM] = match;
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = parseInt(startH!) * 60 + parseInt(startM!);
  const endMinutes = parseInt(endH!) * 60 + parseInt(endM!);

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  }
  // 跨午夜
  return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
}
