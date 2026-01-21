// ============================================================================
// MessageBatcher - IPC 消息批处理器
// 优化主进程到渲染进程的消息传递，减少 IPC 调用次数
// ============================================================================

/**
 * 批处理消息结构
 */
export interface BatchedMessage {
  /** 消息类型 */
  type: string;
  /** 消息负载 */
  payload: unknown;
  /** 消息时间戳 */
  timestamp: number;
}

/**
 * 消息发送函数类型
 */
export type MessageSender = (messages: BatchedMessage[]) => void;

/**
 * 默认批处理间隔（毫秒）
 */
const DEFAULT_BATCH_INTERVAL = 50;

/**
 * 消息批处理器
 *
 * 用于优化高频 IPC 消息传递：
 * - 首条消息立即发送（无延迟）
 * - 后续消息在批处理间隔内收集，然后批量发送
 * - 支持手动刷新和资源清理
 *
 * @example
 * ```typescript
 * const batcher = new MessageBatcher((messages) => {
 *   mainWindow.webContents.send('batched-messages', messages);
 * });
 *
 * // 发送消息
 * batcher.send('agent:event', { type: 'token', data: 'hello' });
 * batcher.send('agent:event', { type: 'token', data: 'world' });
 *
 * // 清理
 * batcher.destroy();
 * ```
 */
export class MessageBatcher {
  private sender: MessageSender;
  private batchInterval: number;
  private pendingMessages: BatchedMessage[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSendTime: number = 0;
  private destroyed: boolean = false;

  /**
   * 创建消息批处理器
   *
   * @param sender - 批量消息发送函数
   * @param batchInterval - 批处理间隔（毫秒），默认 50ms
   */
  constructor(sender: MessageSender, batchInterval: number = DEFAULT_BATCH_INTERVAL) {
    this.sender = sender;
    this.batchInterval = batchInterval;
  }

  /**
   * 发送消息
   *
   * 如果是批处理周期内的首条消息，立即发送；
   * 否则加入队列，等待批处理定时器触发。
   *
   * @param type - 消息类型
   * @param payload - 消息负载
   */
  send(type: string, payload: unknown): void {
    if (this.destroyed) {
      return;
    }

    const message: BatchedMessage = {
      type,
      payload,
      timestamp: Date.now(),
    };

    const now = Date.now();
    const timeSinceLastSend = now - this.lastSendTime;

    // 如果距离上次发送超过批处理间隔，立即发送
    if (timeSinceLastSend >= this.batchInterval) {
      this.sendImmediate(message);
    } else {
      // 否则加入队列
      this.pendingMessages.push(message);
      this.scheduleFlush();
    }
  }

  /**
   * 立即发送单条消息
   */
  private sendImmediate(message: BatchedMessage): void {
    this.lastSendTime = Date.now();
    this.sender([message]);
  }

  /**
   * 调度批量发送
   */
  private scheduleFlush(): void {
    // 如果已有定时器，不重复创建
    if (this.timer !== null) {
      return;
    }

    // 计算到下一个批处理时间点的剩余时间
    const elapsed = Date.now() - this.lastSendTime;
    const delay = Math.max(0, this.batchInterval - elapsed);

    this.timer = setTimeout(() => {
      this.flushPending();
    }, delay);
  }

  /**
   * 发送所有待处理的消息
   */
  private flushPending(): void {
    this.timer = null;

    if (this.pendingMessages.length === 0) {
      return;
    }

    const messages = this.pendingMessages;
    this.pendingMessages = [];
    this.lastSendTime = Date.now();

    this.sender(messages);
  }

  /**
   * 强制立即发送所有待处理的消息
   *
   * 用于以下场景：
   * - 会话结束时确保所有消息已发送
   * - 窗口关闭前清空消息队列
   */
  flush(): void {
    if (this.destroyed) {
      return;
    }

    // 清除定时器
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // 发送待处理消息
    this.flushPending();
  }

  /**
   * 销毁批处理器
   *
   * 清理所有资源，包括：
   * - 清除定时器
   * - 发送剩余消息
   * - 标记为已销毁
   */
  destroy(): void {
    if (this.destroyed) {
      return;
    }

    // 先刷新剩余消息
    this.flush();

    // 标记为已销毁
    this.destroyed = true;

    // 清空引用
    this.pendingMessages = [];
  }

  /**
   * 获取待处理消息数量
   *
   * 用于调试和监控
   */
  get pendingCount(): number {
    return this.pendingMessages.length;
  }

  /**
   * 检查批处理器是否已销毁
   */
  get isDestroyed(): boolean {
    return this.destroyed;
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建用于 Electron BrowserWindow 的消息批处理器
 *
 * @param webContents - Electron WebContents 实例
 * @param channel - IPC 通道名称
 * @param batchInterval - 批处理间隔（毫秒）
 * @returns MessageBatcher 实例
 *
 * @example
 * ```typescript
 * import { createWindowBatcher } from './utils/MessageBatcher';
 *
 * const batcher = createWindowBatcher(
 *   mainWindow.webContents,
 *   'agent:batched-events'
 * );
 *
 * batcher.send('token', { content: 'hello' });
 * ```
 */
export function createWindowBatcher(
  webContents: { send: (channel: string, ...args: unknown[]) => void },
  channel: string,
  batchInterval?: number
): MessageBatcher {
  return new MessageBatcher((messages) => {
    webContents.send(channel, messages);
  }, batchInterval);
}
