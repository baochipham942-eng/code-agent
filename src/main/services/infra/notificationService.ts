// ============================================================================
// Notification Service
// 桌面通知服务 - 在 App 非焦点时发送任务完成通知
// ============================================================================

import { Notification, BrowserWindow, app } from '../../platform';
import { IPC_CHANNELS } from '../../../shared/ipc';
import { createLogger } from './logger';
import type { Disposable } from '../serviceRegistry';
import { getServiceRegistry } from '../serviceRegistry';

const logger = createLogger('NotificationService');

export interface TaskNotificationData {
  sessionId: string;
  sessionTitle: string;
  summary?: string;
  duration: number;
  toolsUsed: string[];
}

export interface RecordedNotification {
  id: string;
  type: 'needs_input' | 'task_complete';
  sessionId: string;
  title: string;
  body: string;
  createdAt: number;
  delivery: 'sent' | 'dry_run';
}

class NotificationService implements Disposable {
  private enabled: boolean = true;
  private disposed = false;
  private recentNotifications: RecordedNotification[] = [];

  private isDryRun(): boolean {
    return process.env.CODE_AGENT_NOTIFICATION_DRY_RUN === '1';
  }

  private record(notification: Omit<RecordedNotification, 'id' | 'createdAt' | 'delivery'>): RecordedNotification {
    const entry: RecordedNotification = {
      ...notification,
      id: `notification_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      delivery: this.isDryRun() ? 'dry_run' : 'sent',
    };
    this.recentNotifications.push(entry);
    if (this.recentNotifications.length > 50) {
      this.recentNotifications.shift();
    }
    return entry;
  }

  getRecentNotifications(): RecordedNotification[] {
    return [...this.recentNotifications];
  }

  clearRecentNotifications(): void {
    this.recentNotifications = [];
  }

  /**
   * 检查是否应该发送通知
   * 只在 App 窗口非焦点时发送
   */
  private shouldNotify(force = false): boolean {
    if (!this.enabled) return false;
    if (this.isDryRun()) return true;
    if (!Notification.isSupported()) return false;

    // force：后台任务（loop/定时任务）完成——绕过焦点门，无论 app 前台/后台都提醒。
    // 这类任务是用户主动发起、默默长跑、完成才冒头，提醒符合预期，不算打扰。
    // 「切到别的会话」≠「app 失焦」，普通焦点门会漏掉这种完成提醒。
    if (force) return true;

    // 前台 agent 任务：仅在 app 整体失焦时提醒，避免你正盯着看时被打扰。
    const focusedWindow = BrowserWindow.getFocusedWindow();
    return focusedWindow === null;
  }

  private showNotification(notification: Notification): void {
    if (this.isDryRun()) return;
    notification.show();
  }

  /**
   * 格式化时长显示
   */
  private formatDuration(ms: number): string {
    if (ms < 1000) return '不到 1 秒';
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (remainingSeconds === 0) return `${minutes} 分钟`;
    return `${minutes} 分 ${remainingSeconds} 秒`;
  }

  /**
   * 发送 "需要输入" 通知（权限请求、用户提问）
   */
  notifyNeedsInput(data: { sessionId: string; title: string; body: string }): void {
    if (!this.shouldNotify()) return;

    const notification = new Notification({
      title: data.title,
      body: data.body,
      silent: false,
      urgency: 'critical',
      ...(process.platform === 'darwin' && { sound: 'default' }),
    });

    notification.on('click', () => {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length > 0) {
        const mainWindow = windows[0];
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
        mainWindow.webContents.send(IPC_CHANNELS.NOTIFICATION_CLICKED, {
          sessionId: data.sessionId,
        });
      }
    });

    this.showNotification(notification);
    this.record({
      type: 'needs_input',
      sessionId: data.sessionId,
      title: data.title,
      body: data.body,
    });
    logger.info('Needs-input notification sent', { title: data.title });
  }

  /**
   * 发送任务完成通知
   * @param options.force 后台任务（loop/定时任务）完成时传 true，绕过焦点门强制提醒
   */
  notifyTaskComplete(data: TaskNotificationData, options?: { force?: boolean }): void {
    if (!this.shouldNotify(options?.force)) {
      logger.debug('Skip notification - app is focused');
      return;
    }

    const { sessionTitle, summary, duration, toolsUsed } = data;

    // 构建通知内容
    let body = '';
    if (summary) {
      body = summary;
    } else if (toolsUsed.length > 0) {
      body = `使用了 ${toolsUsed.length} 个工具`;
    }
    body += `\n耗时: ${this.formatDuration(duration)}`;

    const notification = new Notification({
      title: `任务完成 - ${sessionTitle}`,
      body: body.trim(),
      silent: false,
      // macOS 特有
      ...(process.platform === 'darwin' && {
        sound: 'default',
      }),
    });

    // 点击通知时激活窗口
    notification.on('click', () => {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length > 0) {
        const mainWindow = windows[0];
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }
        mainWindow.focus();
        // 通过 IPC 切换到对应会话
        mainWindow.webContents.send(IPC_CHANNELS.NOTIFICATION_CLICKED, {
          sessionId: data.sessionId,
        });
      }
    });

    this.showNotification(notification);
    this.record({
      type: 'task_complete',
      sessionId: data.sessionId,
      title: `任务完成 - ${sessionTitle}`,
      body: body.trim(),
    });
    logger.info('Notification sent', { sessionTitle });
  }

  /**
   * 启用/禁用通知
   */
  /**
   * Disposable implementation for ServiceRegistry
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.enabled = false;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    logger.info('Notifications', { enabled });
  }

  /**
   * 获取通知状态
   */
  isEnabled(): boolean {
    return this.enabled && (this.isDryRun() || Notification.isSupported());
  }
}

// 单例导出
const notificationServiceInstance = new NotificationService();
getServiceRegistry().register('NotificationService', notificationServiceInstance);
export const notificationService = notificationServiceInstance;
