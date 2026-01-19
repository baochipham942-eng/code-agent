// ============================================================================
// Notification Service
// 桌面通知服务 - 在 App 非焦点时发送任务完成通知
// ============================================================================

import { Notification, BrowserWindow, app } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc';

export interface TaskNotificationData {
  sessionId: string;
  sessionTitle: string;
  summary?: string;
  duration: number;
  toolsUsed: string[];
}

class NotificationService {
  private enabled: boolean = true;

  /**
   * 检查是否应该发送通知
   * 只在 App 窗口非焦点时发送
   */
  private shouldNotify(): boolean {
    if (!this.enabled) return false;
    if (!Notification.isSupported()) return false;

    // 检查是否有焦点窗口
    const focusedWindow = BrowserWindow.getFocusedWindow();
    return focusedWindow === null;
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
   * 发送任务完成通知
   */
  notifyTaskComplete(data: TaskNotificationData): void {
    if (!this.shouldNotify()) {
      console.log('[NotificationService] Skip notification - app is focused');
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

    notification.show();
    console.log('[NotificationService] Notification sent:', sessionTitle);
  }

  /**
   * 启用/禁用通知
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    console.log('[NotificationService] Notifications', enabled ? 'enabled' : 'disabled');
  }

  /**
   * 获取通知状态
   */
  isEnabled(): boolean {
    return this.enabled && Notification.isSupported();
  }
}

// 单例导出
export const notificationService = new NotificationService();
