// ============================================================================
// Notification Service
// 桌面通知服务 - 在 App 非焦点时发送任务完成通知
// ============================================================================

import { Notification, AppWindow, broadcastToRenderer } from '../../platform';
import { IPC_CHANNELS } from '../../../shared/ipc';
import { createLogger } from './logger';
import type { Disposable } from '../serviceRegistry';
import { getServiceRegistry } from '../serviceRegistry';
import {
  evaluateNotificationPolicy,
  sanitizeNotificationText,
  type NotificationIntent,
} from './notificationPolicy';

const logger = createLogger('NotificationService');

export interface TaskNotificationData {
  sessionId: string;
  sessionTitle: string;
  summary?: string;
  duration: number;
  toolsUsed: string[];
  /** false 表示任务失败——通知标题用「任务失败」而非「任务完成」。缺省视为成功。 */
  succeeded?: boolean;
}

/** 只在本文件内当 notifyVoiceWorkSettled 的参数类型用；导出无人引用会顶爆 knip 零余量棘轮。 */
interface VoiceWorkSettledNotificationData {
  sessionId: string;
  taskTitle: string;
  status: 'done' | 'failed';
  detail?: string;
}

export interface RecordedNotification {
  id: string;
  type: 'needs_input' | 'task_complete' | 'task_failed';
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
      title: sanitizeNotificationText(notification.title, 120),
      body: sanitizeNotificationText(notification.body, 320),
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
    const focusedWindow = AppWindow.getFocusedWindow();
    return focusedWindow === null;
  }

  /**
   * 投递系统通知：交给渲染端用 Tauri 通知插件发送——原生通知自动带 app（Agent Neo）
   * 图标与身份，点击经 onAction 跳到对应会话。替代旧的 osascript（无图标、点击不回调）。
   * dry-run 下只记录不投递（E2E 用 getRecent 断言，不真弹）。
   */
  private deliver(payload: {
    id: string;
    title: string;
    body: string;
    sessionId: string;
    markSessionUnread?: boolean;
  }): void {
    if (this.isDryRun()) return;
    broadcastToRenderer(IPC_CHANNELS.NOTIFICATION_SHOW, {
      ...payload,
      title: sanitizeNotificationText(payload.title, 120),
      body: sanitizeNotificationText(payload.body, 320),
    });
  }

  private isIntentAllowed(intent: NotificationIntent): boolean {
    const decision = evaluateNotificationPolicy(intent);
    if (!decision.allowed) {
      logger.debug('Notification blocked by policy', { intent, reason: decision.reason });
    }
    return decision.allowed;
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
    if (!this.isIntentAllowed('needs_input')) return;
    if (!this.shouldNotify()) return;

    const entry = this.record({
      type: 'needs_input',
      sessionId: data.sessionId,
      title: data.title,
      body: data.body,
    });
    this.deliver({ id: entry.id, title: entry.title, body: entry.body, sessionId: data.sessionId });
    logger.info('Needs-input notification sent', { title: data.title });
  }

  /**
   * 发送任务完成通知
   * @param options.force 后台任务（loop/定时任务）完成时传 true，绕过焦点门强制提醒
   */
  notifyTaskComplete(data: TaskNotificationData, options?: { force?: boolean }): void {
    const intent: NotificationIntent = data.succeeded === false ? 'task_failed' : 'task_complete';
    if (!this.isIntentAllowed(intent)) return;
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

    const title = `${data.succeeded === false ? '任务失败' : '任务完成'} - ${sessionTitle}`;
    const trimmedBody = body.trim();
    const entry = this.record({
      type: intent,
      sessionId: data.sessionId,
      title,
      body: trimmedBody,
    });
    this.deliver({ id: entry.id, title: entry.title, body: entry.body, sessionId: data.sessionId });
    logger.info('Notification sent', { sessionTitle });
  }

  /**
   * 语音派出的活在通话挂断后才落终态：强制投递一条带任务名的通知，并让侧栏
   * 把目标会话接到既有未读圆点。调用方负责用通话账本判定是否已经挂断。
   */
  notifyVoiceWorkSettled(data: VoiceWorkSettledNotificationData): void {
    const succeeded = data.status === 'done';
    const intent: NotificationIntent = succeeded ? 'task_complete' : 'task_failed';
    if (!this.isIntentAllowed(intent)) return;
    if (!this.shouldNotify(true)) {
      logger.debug('Skip voice work notification - notifications unavailable');
      return;
    }

    const title = `${succeeded ? '语音任务完成' : '语音任务失败'} - ${data.taskTitle}`;
    const body = succeeded
      ? '这件语音派出的任务在通话结束后完成了。'
      : `这件语音派出的任务在通话结束后失败了：${data.detail?.trim() || '未给出原因'}`;
    const entry = this.record({
      type: intent,
      sessionId: data.sessionId,
      title,
      body,
    });
    this.deliver({
      id: entry.id,
      title: entry.title,
      body: entry.body,
      sessionId: data.sessionId,
      markSessionUnread: true,
    });
    logger.info('Voice work settlement notification sent', {
      sessionId: data.sessionId,
      taskTitle: data.taskTitle,
      status: data.status,
    });
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
