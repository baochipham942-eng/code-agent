// ============================================================================
// Background Task Manager - 后台任务管理
// ============================================================================

import { EventEmitter } from 'events';
import { AppWindow, broadcastToRenderer } from '../platform';
import { createLogger } from '../services/infra/logger';
import { getSessionManager, notificationService } from '../services';
import { BACKGROUND_TASK_CANCELLED, RUN_ERROR_CODE_MAX_ITERATIONS } from '../../shared/constants';
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

    // 检查是否已在后台：running 条目重复请求是 no-op；终态条目（完成/失败/停止行
    // 常驻面板直到用户清除）要重置回 running——否则同一会话再次转后台后，新 run 的
    // 终态收线会撞上旧终态条目被 running-guard 挡掉，面板永远显示旧结果。
    const existing = this.backgroundSessions.get(sessionId);
    if (existing) {
      if (existing.status === 'running') {
        logger.debug('Session already in background', { sessionId });
        return true;
      }
      this.backgroundSessions.delete(sessionId);
      this.emitUpdate({ type: 'removed', task: existing });
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
   *
   * running-guard：只收 running 态的条目。同一条目的 task_complete 与 agent_complete
   * 收口点会先后到、SSE 重放也可能重复投递——已收线的条目再收一次只会重复弹通知，
   * 不允许。终态条目常驻列表直到用户清除（dismissTerminal）或切前台——不自动删除，
   * 否则用户没盯着面板的 3 秒窗口一过结果就没了（N-BGPANEL-STOP-TERMINAL）。
   */
  async markCompleted(sessionId: string, message?: string): Promise<void> {
    const task = this.backgroundSessions.get(sessionId);
    if (task?.status !== 'running') return;

    task.status = 'completed';
    task.progress = 100;
    task.completionMessage = message;

    logger.info('Background task completed', { sessionId, message });

    this.emitUpdate({
      type: 'completed',
      task,
    });

    // 发送系统通知。force：后台完成提醒绕过焦点门——用户可能正停在 app 里聊别的会话
    // （与 loop/定时任务同一档「默默长跑、完成才冒头」）。通知摘要不吃裸 code
    // （USER_CANCELLED 由 renderer 翻译面板行；系统通知这头就地给人话）。
    notificationService.notifyTaskComplete({
      sessionId,
      sessionTitle: task.title,
      summary: message === BACKGROUND_TASK_CANCELLED ? '任务已停止' : message || '任务已完成',
      duration: Date.now() - task.startedAt,
      toolsUsed: [],
    }, { force: true });
  }

  /**
   * 标记后台任务失败
   *
   * running-guard 同 markCompleted。通知 force：用户多半停在 app 里聊别的会话，
   * 失败与完成同一档「默默长跑、终态才冒头」——焦点门不该吞掉失败提醒
   * （2026-10-11 验收：撞 max-step 上限的失败轮无任何提示）。
   */
  markFailed(sessionId: string, error?: string): void {
    const task = this.backgroundSessions.get(sessionId);
    if (task?.status !== 'running') return;

    task.status = 'failed';
    task.completionMessage = error || '任务执行失败';

    logger.warn('Background task failed', { sessionId, error });

    this.emitUpdate({
      type: 'failed',
      task,
    });

    // 发送系统通知。succeeded:false → 标题「任务失败」；MAX_ITERATIONS code 就地翻人话。
    notificationService.notifyTaskComplete({
      sessionId,
      sessionTitle: task.title,
      summary: error === RUN_ERROR_CODE_MAX_ITERATIONS
        ? '已达最大执行轮次，任务停止（部分结果已保留）'
        : `任务失败: ${error || '未知错误'}`,
      duration: Date.now() - task.startedAt,
      toolsUsed: [],
      succeeded: false,
    }, { force: true });
  }

  /**
   * 清除已结束的后台条目（终态行手动清除，N-BGPANEL-STOP-TERMINAL）
   *
   * running 态 no-op：运行中的条目只能停（AGENT_CANCEL 走 run 取消链路）或切前台，
   * 不允许从面板凭空消失。
   */
  dismissTerminal(sessionId: string): boolean {
    const task = this.backgroundSessions.get(sessionId);
    if (!task || task.status === 'running') {
      logger.debug('Background task not dismissible', { sessionId });
      return false;
    }

    this.backgroundSessions.delete(sessionId);

    logger.info('Background task dismissed', { sessionId });

    this.emitUpdate({
      type: 'removed',
      task,
    });

    return true;
  }

  /**
   * 检查会话是否在后台运行
   */
  isInBackground(sessionId: string): boolean {
    return this.backgroundSessions.has(sessionId);
  }

  /**
   * 后台条目是否仍是 running 态（收线幂等判据：completed/failed 都算已收线）
   */
  isTaskRunning(sessionId: string): boolean {
    return this.backgroundSessions.get(sessionId)?.status === 'running';
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

    // web 路径（浏览器/无槽验证）：与 notificationService.deliver 同款 renderer bus → SSE。
    // Tauri 渲染端不走 SSE（bridge 模式无订阅者，emit 静默丢弃），不会与 webContents 重复投递。
    broadcastToRenderer('background:task:update', event);

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
