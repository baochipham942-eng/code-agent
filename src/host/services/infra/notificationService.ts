// ============================================================================
// Notification Service
// 桌面通知服务 - 在 App 非焦点时发送任务完成通知
// ============================================================================

import { Notification, AppWindow, broadcastToRenderer } from '../../platform';
import { IPC_CHANNELS } from '../../../shared/ipc';
import type { CronFailurePresentationKind } from '../../../shared/utils/cronFailureClassification';
import { createLogger } from './logger';
import type { Disposable } from '../serviceRegistry';
import { getServiceRegistry } from '../serviceRegistry';
import {
  evaluateNotificationPolicy,
  sanitizeNotificationText,
  type NotificationIntent,
} from './notificationPolicy';
import { getConfigService } from '../core/configService';
import { getDaemonQuitIntent } from '../daemon/quitIntent';
import { getDurableResumeNotificationText } from '../../../shared/i18n/durableResumeNotification';
import {
  getNotificationDigestText,
  type NotificationDigestLocale,
} from '../../../shared/i18n/notificationDigest';
import { NotificationBudget, type NotificationBudgetDisposition, type NotificationBudgetItem } from './notificationBudget';

const logger = createLogger('NotificationService');

/**
 * needs-input 去重键容量：同一 dedupeKey 只投递一次，超限丢最旧（Set 保持插入序，
 * 首元素即最旧）。有界内存，防长跑进程无限膨胀。
 */
const NEEDS_INPUT_DEDUPE_KEY_LIMIT = 200;

/** 通知文案语言跟随用户设置（ui.language）；读取失败按中文兜底，通知本身不许把恢复路径炸掉。 */
function readNotificationLocale(): NotificationDigestLocale {
  try {
    return getConfigService().getSettings().ui.language === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

export interface TaskNotificationData {
  sessionId: string;
  sessionTitle: string;
  /** Source cron job for explicit login-wall consent from the notification. */
  jobId?: string;
  summary?: string;
  duration: number;
  toolsUsed: string[];
  /** false 表示任务失败——通知标题用「任务失败」而非「任务完成」。缺省视为成功。 */
  succeeded?: boolean;
  code?: string;
  siteOrigin?: string;
  failureKind?: CronFailurePresentationKind;
  resetAt?: string;
}

interface TaskResumingNotificationData {
  sessionId: string;
  sessionTitle: string;
  autoResumeCount: number;
}

/** 只在本文件内当 notifyVoiceWorkSettled 的参数类型用；导出无人引用会顶爆 knip 零余量棘轮。 */
interface VoiceWorkSettledNotificationData {
  sessionId: string;
  taskTitle: string;
  status: 'done' | 'unverified' | 'failed';
  detail?: string;
}

export interface RecordedNotification {
  id: string;
  type: 'needs_input' | 'task_complete' | 'task_failed' | 'task_resuming' | 'plugin' | 'digest';
  sessionId: string;
  title: string;
  body: string;
  createdAt: number;
  delivery: 'sent' | 'dry_run';
}

interface NotificationDeliveryPayload {
  id: string;
  title: string;
  body: string;
  sessionId: string;
  jobId?: string;
  markSessionUnread?: boolean;
  code?: string;
  siteOrigin?: string;
  failureKind?: CronFailurePresentationKind;
  resetAt?: string;
  /** 失败类 / 需要输入类通知：renderer 端即使窗口聚焦也要弹。 */
  urgent?: boolean;
  /** 仅任务失败；renderer 聚焦时据此补应用内错误 toast（needs-input 不带）。 */
  failure?: boolean;
  /** needs-input 去重键：随通知带给 renderer，裁决后按它撤回（retractNeedsInput）。 */
  dedupeKey?: string;
}

interface BudgetedNotification extends NotificationBudgetItem {
  type: RecordedNotification['type'];
  body: string;
  delivery: Omit<NotificationDeliveryPayload, 'id' | 'title' | 'body' | 'sessionId'>;
}

class NotificationService implements Disposable {
  private enabled: boolean = true;
  private disposed = false;
  private recentNotifications: RecordedNotification[] = [];
  /** 已按 dedupeKey 投递过的 needs-input 键（有界，见 NEEDS_INPUT_DEDUPE_KEY_LIMIT）。 */
  private deliveredNeedsInputKeys: Set<string> = new Set();
  private readonly budget = new NotificationBudget<BudgetedNotification>({
    deliver: (item) => this.deliverNow(item),
    deliverDigest: (items) => this.deliverDigest(items),
  });

  /**
   * Fallback B 原生通知发送器（N-RESIDENT-SCHEDULE-KEEPALIVE-DAEMON-FU1）。默认走
   * osascript（host 侧，壳死了也能弹）；单测注入替身，不真弹系统通知。
   */
  private nativeNotificationSender: (payload: { title: string; body: string }) => void = (payload) => {
    new Notification({ title: payload.title, body: payload.body }).show();
  };

  /** 测试注入原生通知替身；不传恢复默认 osascript 路径。 */
  setNativeNotificationSender(sender: ((payload: { title: string; body: string }) => void) | null): void {
    this.nativeNotificationSender = sender ?? ((payload) => {
      new Notification({ title: payload.title, body: payload.body }).show();
    });
  }

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
    this.deliveredNeedsInputKeys.clear();
    this.budget.clear();
  }

  /**
   * 检查是否应该发送通知
   * 默认只在 App 窗口非焦点时发送；needs_input / 失败类 / force 绕过焦点门
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
  private deliverNow(item: BudgetedNotification): void {
    const entry = this.record({
      type: item.type,
      sessionId: item.sessionId,
      title: item.title,
      body: item.body,
    });
    this.deliver({
      id: entry.id,
      title: entry.title,
      body: entry.body,
      sessionId: entry.sessionId,
      ...item.delivery,
    });
  }

  private deliverDigest(items: readonly BudgetedNotification[]): void {
    const text = getNotificationDigestText(readNotificationLocale());
    logger.info('Notification folded into digest', { reason: 'budget-digest', count: items.length });
    this.deliverNow({
      intent: 'task_complete',
      type: 'digest',
      sessionId: '',
      title: text.title(items.length),
      body: text.body(items.map((item) => item.title), items.length),
      delivery: {},
    });
  }

  private deliver(payload: NotificationDeliveryPayload): void {
    if (this.isDryRun()) return;
    broadcastToRenderer(IPC_CHANNELS.NOTIFICATION_SHOW, {
      ...payload,
      title: sanitizeNotificationText(payload.title, 120),
      body: sanitizeNotificationText(payload.body, 320),
    });
  }

  /**
   * 预算把通知折进窗口时，其未读标记不能跟着等窗口收尾：暂存当下就单独广播一条
   * attentionOnly 事件（渲染端只接未读圆点、不弹 OS 通知），之后的窗尾投递不再重复标记。
   */
  private broadcastSessionAttentionMark(sessionId: string): void {
    if (this.isDryRun()) return;
    broadcastToRenderer(IPC_CHANNELS.NOTIFICATION_SHOW, {
      id: `notification_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title: '',
      body: '',
      sessionId,
      markSessionUnread: true,
      attentionOnly: true,
    });
  }

  private enqueueBudgeted(item: BudgetedNotification): NotificationBudgetDisposition {
    const disposition = this.budget.enqueue(item);
    if (disposition !== 'held') return disposition;
    logger.info('Notification held by budget', { reason: 'budget-held', intent: item.intent, sessionId: item.sessionId });
    if (!item.delivery.markSessionUnread) return disposition;
    this.broadcastSessionAttentionMark(item.sessionId);
    delete item.delivery.markSessionUnread;
    return disposition;
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
   * 一律 urgent：绕过 host 焦点门与 renderer 普通焦点门。renderer 仅在 app 聚焦且用户
   * 正看着该 sessionId 对应会话时不弹横幅（卡片已在屏幕上）；看别的会话/失焦/隐藏仍弹。
   * dedupeKey：同一条逻辑请求可能从两个发送口到达（停车通知 + 事件落库通知），
   * 携带同一键的第二次调用在门后、投递前被丢弃；无键 = 行为不变。
   */
  notifyNeedsInput(data: { sessionId: string; title: string; body: string; dedupeKey?: string }): void {
    if (!this.isIntentAllowed('needs_input')) return;
    if (!this.shouldNotify(true)) return;

    if (data.dedupeKey) {
      if (this.deliveredNeedsInputKeys.has(data.dedupeKey)) {
        logger.info('Notification not delivered', { reason: 'dedupe-duplicate', dedupeKey: data.dedupeKey });
        return;
      }
      this.deliveredNeedsInputKeys.add(data.dedupeKey);
      if (this.deliveredNeedsInputKeys.size > NEEDS_INPUT_DEDUPE_KEY_LIMIT) {
        const oldest = this.deliveredNeedsInputKeys.values().next().value;
        if (oldest !== undefined) this.deliveredNeedsInputKeys.delete(oldest);
      }
    }

    this.enqueueBudgeted({
      intent: 'needs_input',
      type: 'needs_input',
      sessionId: data.sessionId,
      title: data.title,
      body: data.body,
      delivery: {
        urgent: true,
        markSessionUnread: true,
        ...(data.dedupeKey ? { dedupeKey: data.dedupeKey } : {}),
      },
    });
    // Fallback B（N-RESIDENT-SCHEDULE-KEEPALIVE-DAEMON-FU1）：deliver 只广播给 renderer，
    // 渲染端没了（壳声明「后台继续」退出，ADR-083）时 toast 没有落点——再弹一条 host 侧
    // 原生通知兜底。文案不复制调用方的 title/body（那可能带工具名），用固定人话。
    // 已知局限：意图声明后没有「壳重新接上」的复位事件，重开后 needs_input 会
    // renderer toast + 原生通知双弹（见证据档）；放着不修是刻意的——漏报比重复打扰贵。
    if (getDaemonQuitIntent() === 'background') {
      try {
        this.nativeNotificationSender({
          title: '有事项需要你确认',
          body: '后台任务在等你确认，打开 Agent Neo 处理。',
        });
      } catch (error) {
        logger.warn('Native needs-input notification failed', { error });
      }
    }
    logger.info('Needs-input notification sent', { title: data.title });
  }

  /**
   * 撤回一条已投递的 needs-input 通知（审批裁决后调用，N-FIX-PARKED-BANNER-STALE-AFTER-RESOLVE）：
   * 在同一 NOTIFICATION_SHOW 通道广播一条带 retract 标记、携带原 dedupeKey 的事件，
   * renderer 据此把「离开期间的提醒」队列里那条移掉——用户回来不再被一条已处理完的
   * 「有操作等你确认」补提醒误导。没投递过的键是 no-op（不广播）；重复撤回幂等。
   * 已知局限：桌面壳已弹出的系统横幅撤不回（tauri-plugin-notification desktop 端无
   * remove_active），只收回 renderer 侧的补提醒队列。
   */
  retractNeedsInput(dedupeKey: string): void {
    if (!this.deliveredNeedsInputKeys.has(dedupeKey)) {
      logger.debug('Skip retract for a needs-input key that was never delivered', { dedupeKey });
      return;
    }
    if (this.isDryRun()) return;
    broadcastToRenderer(IPC_CHANNELS.NOTIFICATION_SHOW, {
      id: `notification_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title: '',
      body: '',
      sessionId: '',
      dedupeKey,
      retract: true,
    });
    logger.info('Needs-input notification retracted', { dedupeKey });
  }

  /**
   * 发送任务完成通知
   * @param options.force 后台任务（loop/定时任务）完成时传 true，绕过焦点门强制提醒
   */
  notifyTaskComplete(data: TaskNotificationData, options?: { force?: boolean; urgent?: boolean }): void {
    const intent: NotificationIntent = data.succeeded === false ? 'task_failed' : 'task_complete';
    if (!this.isIntentAllowed(intent)) return;
    // 失败类通知不受焦点门限制：用户盯着别的会话时也不能错过失败。
    if (!this.shouldNotify(options?.force || intent === 'task_failed')) {
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
    const disposition = this.enqueueBudgeted({
      intent,
      urgent: options?.urgent,
      type: intent,
      sessionId: data.sessionId,
      title,
      body: body.trim(),
      delivery: {
        ...(data.jobId ? { jobId: data.jobId } : {}),
        ...(data.code ? { code: data.code } : {}),
        ...(data.siteOrigin ? { siteOrigin: data.siteOrigin } : {}),
        ...(data.failureKind ? { failureKind: data.failureKind } : {}),
        ...(data.resetAt ? { resetAt: data.resetAt } : {}),
        ...(intent === 'task_failed' ? { urgent: true, failure: true, markSessionUnread: true } : {}),
      },
    });
    if (disposition === 'delivered') logger.info('Notification dispatched to renderer', { sessionTitle });
  }

  /** Background restart-resume is silent in the chat surface, so expose one system signal. */
  notifyTaskResuming(data: TaskResumingNotificationData): void {
    if (!this.isIntentAllowed('task_resuming')) return;
    if (!this.shouldNotify(true)) return;
    const text = getDurableResumeNotificationText(readNotificationLocale());
    // 兜底会话名必须与通知同语言，所以在这里（知道 locale 的一方）落兜底，调用方传原始标题。
    const title = text.resumingTitle(data.sessionTitle || text.untitledSession);
    const body = text.resumingBody(data.autoResumeCount);
    this.enqueueBudgeted({
      intent: 'task_resuming',
      type: 'task_resuming',
      sessionId: data.sessionId,
      title,
      body,
      delivery: { markSessionUnread: true },
    });
    logger.info('Task resume notification sent', { sessionId: data.sessionId, autoResumeCount: data.autoResumeCount });
  }

  /**
   * 发送插件主动请求的系统通知。插件没有目标会话，因此通知点击只负责唤起应用，
   * 不会尝试切换到不存在的会话。
   */
  notifyPlugin(data: { title: string; body: string }): void {
    if (!this.isIntentAllowed('plugin')) return;
    if (!this.shouldNotify()) {
      logger.debug('Skip plugin notification - app is focused');
      return;
    }

    this.enqueueBudgeted({
      intent: 'plugin',
      type: 'plugin',
      sessionId: '',
      title: data.title,
      body: data.body,
      delivery: {},
    });
    logger.info('Plugin notification sent', { title: data.title });
  }

  /**
   * 语音派出的活在通话挂断后才落终态：强制投递一条带任务名的通知，并让侧栏
   * 把目标会话接到既有未读圆点。调用方负责用通话账本判定是否已经挂断。
   */
  notifyVoiceWorkSettled(data: VoiceWorkSettledNotificationData): void {
    const succeeded = data.status === 'done';
    // 待核验按「完成类」投递（它不是失败，别用红色语气吓人），但标题正文一个字都不许
    // 说「完成了」——通知是第四条用户可见出口，与卡片/播报同口径（X5.5-A2-a）。
    const intent: NotificationIntent = data.status === 'failed' ? 'task_failed' : 'task_complete';
    if (!this.isIntentAllowed(intent)) return;
    if (!this.shouldNotify(true)) {
      logger.debug('Skip voice work notification - notifications unavailable');
      return;
    }

    const headline = succeeded
      ? '语音任务完成'
      : data.status === 'unverified' ? '语音任务已结束 · 待核验' : '语音任务失败';
    const title = `${headline} - ${data.taskTitle}`;
    const body = succeeded
      ? '这件语音派出的任务在通话结束后完成了。'
      : data.status === 'unverified'
        ? '这件语音派出的任务在通话结束后跑完了，但没有留下产物，请你自己确认一下结果。'
        : `这件语音派出的任务在通话结束后失败了：${data.detail?.trim() || '未给出原因'}`;
    this.enqueueBudgeted({
      intent,
      type: intent,
      sessionId: data.sessionId,
      title,
      body,
      delivery: {
        markSessionUnread: true,
        ...(intent === 'task_failed' ? { urgent: true, failure: true } : {}),
      },
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
    this.budget.dispose();
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
