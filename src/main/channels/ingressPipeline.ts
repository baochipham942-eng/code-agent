// ============================================================================
// Ingress Pipeline - 消息入口管线
// ============================================================================
// 在 channelAgentBridge 与 orchestrator 之间插入管线
// 三层机制: debounce + session lock + bounded queue
// ============================================================================

import { createLogger } from '../services/infra/logger';

const logger = createLogger('IngressPipeline');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface IngressMessage {
  /** 会话标识 (accountId:chatId) */
  sessionKey: string;
  /** 消息内容 */
  content: string;
  /** 原始时间戳 */
  timestamp: number;
  /** 透传的元数据 */
  metadata?: Record<string, unknown>;
}

export interface IngressConfig {
  /** debounce 延迟 (ms)，同 sessionKey 连续消息合并 */
  debounceMs: number;
  /** 队列最大容量 */
  maxQueueSize: number;
  /** session 锁超时 (ms) */
  sessionLockTimeoutMs: number;
  /** 实际消息处理函数 */
  processMessage: (msg: IngressMessage) => Promise<void>;
}

export interface IngressStats {
  queueDepth: number;
  activeSession: number;
  debouncing: number;
}

// ----------------------------------------------------------------------------
// IngressPipeline
// ----------------------------------------------------------------------------

export class IngressPipeline {
  private config: IngressConfig;

  /** 等待 debounce 的消息 (key: sessionKey) */
  private debounceBuffer: Map<string, {
    msg: IngressMessage;
    timer: ReturnType<typeof setTimeout>;
  }> = new Map();

  /** 排队中的消息 */
  private queue: IngressMessage[] = [];

  /** 当前正在处理的 session (key: sessionKey) */
  private activeSessions: Set<string> = new Set();

  /** session 锁超时定时器 */
  private lockTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /** 是否正在排空队列 */
  private draining = false;

  constructor(config: Partial<IngressConfig> & Pick<IngressConfig, 'processMessage'>) {
    this.config = {
      debounceMs: config.debounceMs ?? 1500,
      maxQueueSize: config.maxQueueSize ?? 50,
      sessionLockTimeoutMs: config.sessionLockTimeoutMs ?? 300000,
      processMessage: config.processMessage,
    };
  }

  /**
   * 消息入队（带 debounce）
   */
  enqueue(msg: IngressMessage): void {
    const existing = this.debounceBuffer.get(msg.sessionKey);

    if (existing) {
      // 合并内容
      clearTimeout(existing.timer);
      existing.msg.content += '\n' + msg.content;
      existing.msg.timestamp = msg.timestamp;
      existing.timer = setTimeout(() => this.flushDebounce(msg.sessionKey), this.config.debounceMs);
      logger.debug('Debounce merged message', { sessionKey: msg.sessionKey });
    } else {
      // 新消息，设置 debounce 定时器
      const timer = setTimeout(() => this.flushDebounce(msg.sessionKey), this.config.debounceMs);
      this.debounceBuffer.set(msg.sessionKey, { msg: { ...msg }, timer });
      logger.debug('Debounce started', { sessionKey: msg.sessionKey });
    }
  }

  /**
   * 获取管线状态
   */
  getStats(): IngressStats {
    return {
      queueDepth: this.queue.length,
      activeSession: this.activeSessions.size,
      debouncing: this.debounceBuffer.size,
    };
  }

  /**
   * 关闭管线，清除所有定时器
   */
  shutdown(): void {
    // 清除 debounce 定时器
    for (const [, entry] of this.debounceBuffer) {
      clearTimeout(entry.timer);
    }
    this.debounceBuffer.clear();

    // 清除 lock 定时器
    for (const [, timer] of this.lockTimers) {
      clearTimeout(timer);
    }
    this.lockTimers.clear();

    this.queue.length = 0;
    this.activeSessions.clear();
    logger.info('IngressPipeline shutdown');
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  /**
   * debounce 到期，将消息放入队列
   */
  private flushDebounce(sessionKey: string): void {
    const entry = this.debounceBuffer.get(sessionKey);
    if (!entry) return;

    this.debounceBuffer.delete(sessionKey);

    // 有界队列检查
    if (this.queue.length >= this.config.maxQueueSize) {
      const dropped = this.queue.shift();
      logger.warn('Queue overflow, dropped oldest message', {
        droppedSessionKey: dropped?.sessionKey,
        queueSize: this.queue.length,
      });
    }

    this.queue.push(entry.msg);
    logger.debug('Message queued', { sessionKey, queueDepth: this.queue.length });

    // 尝试排空队列
    this.drainQueue();
  }

  /**
   * 排空队列（带 session lock）
   */
  private async drainQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    try {
      while (this.queue.length > 0) {
        // 找到一个未被锁定的消息
        const idx = this.queue.findIndex(msg => !this.activeSessions.has(msg.sessionKey));
        if (idx === -1) break; // 所有消息的 session 都在处理中

        const msg = this.queue.splice(idx, 1)[0]!;

        // 获取 session 锁
        this.activeSessions.add(msg.sessionKey);

        // 设置锁超时保护
        const lockTimer = setTimeout(() => {
          logger.warn('Session lock timeout, force releasing', { sessionKey: msg.sessionKey });
          this.releaseLock(msg.sessionKey);
        }, this.config.sessionLockTimeoutMs);
        this.lockTimers.set(msg.sessionKey, lockTimer);

        // 异步处理（不阻塞其他 session 的消息）
        this.processAndRelease(msg).catch(error => {
          logger.error('Failed to process message', { sessionKey: msg.sessionKey, error: String(error) });
        });
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * 处理消息并释放锁
   */
  private async processAndRelease(msg: IngressMessage): Promise<void> {
    try {
      await this.config.processMessage(msg);
    } catch (error) {
      logger.error('Message processing failed', { sessionKey: msg.sessionKey, error: String(error) });
    } finally {
      this.releaseLock(msg.sessionKey);
      // 处理完成后尝试排空队列中的后续消息
      this.drainQueue();
    }
  }

  /**
   * 释放 session 锁
   */
  private releaseLock(sessionKey: string): void {
    this.activeSessions.delete(sessionKey);
    const timer = this.lockTimers.get(sessionKey);
    if (timer) {
      clearTimeout(timer);
      this.lockTimers.delete(sessionKey);
    }
  }
}
