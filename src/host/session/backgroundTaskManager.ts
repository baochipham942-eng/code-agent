// ============================================================================
// Background Task Manager - 后台任务管理
// ============================================================================

import { EventEmitter } from 'events';
import { AppWindow } from '../platform';
import { createLogger } from '../services/infra/logger';
import { getSessionManager, notificationService } from '../services';
import type { BackgroundSessionInfo, BackgroundTaskUpdateEvent } from '../../shared/contract/sessionState';

const logger = createLogger('BackgroundTaskManager');

/**
 * 后台任务管理器
 *
 * 管理会话的前后台切换：
 * - moveToBackground(): 将运行中的会话移至后台
 * - moveToForeground(): 将后台会话恢复到前台
 * - 后台任务完成时发送系统通知
 */
class BackgroundTaskManager extends EventEmitter {
  private backgroundSessions: Map<string, BackgroundSessionInfo> = new Map();
  private mainWindow: AppWindow | null = null;

  /**
   * 设置主窗口引用（用于发送事件）
   */
  setMainWindow(window: AppWindow | null): void {
    this.mainWindow = window;
  }

  /**
   * 将会话移至后台
   */
  async moveToBackground(sessionId: string): Promise<boolean> {
    // 检查会话是否存在且正在运行
    const sessionManager = getSessionManager();
    const session = await sessionManager.getSession(sessionId);

    if (!session) {
      logger.warn('Session not found', { sessionId });
      return false;
    }

    // 检查是否已在后台
    if (this.backgroundSessions.has(sessionId)) {
      logger.debug('Session already in background', { sessionId });
      return true;
    }

    const sessionInfo: BackgroundSessionInfo = {
      sessionId,
      title: session.title || '未命名会话',
      startedAt: Date.now(),
      backgroundedAt: Date.now(),
      status: 'running',
    };

    this.backgroundSessions.set(sessionId, sessionInfo);

    logger.info('Session moved to background', { sessionId, title: sessionInfo.title });

    this.emitUpdate({
      type: 'added',
      task: sessionInfo,
    });

    return true;
  }

  /**
   * 将后台会话恢复到前台
   */
  moveToForeground(sessionId: string): BackgroundSessionInfo | null {
    const task = this.backgroundSessions.get(sessionId);

    if (!task) {
      logger.debug('Session not in background', { sessionId });
      return null;
    }

    this.backgroundSessions.delete(sessionId);

    logger.info('Session moved to foreground', { sessionId });

    this.emitUpdate({
      type: 'removed',
      task,
    });

    return task;
  }

  /**
   * 更新后台任务进度
   */
  updateProgress(sessionId: string, progress: number): void {
    const task = this.backgroundSessions.get(sessionId);
    if (!task) return;

    task.progress = Math.min(100, Math.max(0, progress));

    this.emitUpdate({
      type: 'updated',
      task,
    });
  }

  /**
   * 标记后台任务完成
   */
  async markCompleted(sessionId: string, message?: string): Promise<void> {
    const task = this.backgroundSessions.get(sessionId);
    if (!task) return;

    task.status = 'completed';
    task.progress = 100;
    task.completionMessage = message;

    logger.info('Background task completed', { sessionId, message });

    this.emitUpdate({
      type: 'completed',
      task,
    });

    // 发送系统通知
    notificationService.notifyTaskComplete({
      sessionId,
      sessionTitle: task.title,
      summary: message || '任务已完成',
      duration: Date.now() - task.startedAt,
      toolsUsed: [],
    });

    // 3 秒后自动从后台列表移除
    setTimeout(() => {
      this.backgroundSessions.delete(sessionId);
      this.emitUpdate({
        type: 'removed',
        task,
      });
    }, 3000);
  }

  /**
   * 标记后台任务失败
   */
  markFailed(sessionId: string, error?: string): void {
    const task = this.backgroundSessions.get(sessionId);
    if (!task) return;

    task.status = 'failed';
    task.completionMessage = error || '任务执行失败';

    logger.warn('Background task failed', { sessionId, error });

    this.emitUpdate({
      type: 'failed',
      task,
    });

    // 发送系统通知
    notificationService.notifyTaskComplete({
      sessionId,
      sessionTitle: task.title,
      summary: `任务失败: ${error || '未知错误'}`,
      duration: Date.now() - task.startedAt,
      toolsUsed: [],
    });
  }

  /**
   * 检查会话是否在后台运行
   */
  isInBackground(sessionId: string): boolean {
    return this.backgroundSessions.has(sessionId);
  }

  /**
   * 获取所有后台任务
   */
  getAllTasks(): BackgroundSessionInfo[] {
    return Array.from(this.backgroundSessions.values());
  }

  /**
   * 获取后台任务数量
   */
  getTaskCount(): number {
    return this.backgroundSessions.size;
  }

  /**
   * 发送更新事件到渲染进程
   */
  private emitUpdate(event: BackgroundTaskUpdateEvent): void {
    this.emit('update', event);

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('background:task:update', event);
    }
  }
}

// Global singleton
let globalInstance: BackgroundTaskManager | null = null;

/**
 * 获取全局 BackgroundTaskManager 实例
 */
export function getBackgroundTaskManager(): BackgroundTaskManager {
  if (!globalInstance) {
    globalInstance = new BackgroundTaskManager();
  }
  return globalInstance;
}

/**
 * 重置全局实例（用于测试）
 */
export function resetBackgroundTaskManager(): void {
  globalInstance = null;
}

export { BackgroundTaskManager };
