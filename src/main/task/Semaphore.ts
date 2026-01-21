// ============================================================================
// Semaphore - Concurrency control for parallel task execution
// ============================================================================

import { createLogger } from '../services/infra/logger';

const logger = createLogger('Semaphore');

/**
 * 信号量 - 控制并发任务数量
 *
 * 用于限制同时运行的 AgentOrchestrator 实例数量，
 * 防止资源耗尽和 API 限速。
 *
 * @example
 * ```typescript
 * const semaphore = new Semaphore(3); // 最多 3 个并发
 *
 * // 获取许可（可能等待）
 * await semaphore.acquire();
 * try {
 *   await runTask();
 * } finally {
 *   semaphore.release();
 * }
 * ```
 */
export class Semaphore {
  private permits: number;
  private maxPermits: number;
  private waiting: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    timeoutId?: ReturnType<typeof setTimeout>;
  }> = [];

  /**
   * 创建信号量
   * @param permits - 最大并发许可数
   */
  constructor(permits: number) {
    if (permits <= 0) {
      throw new Error('Semaphore permits must be positive');
    }
    this.permits = permits;
    this.maxPermits = permits;
    logger.debug(`Semaphore created with ${permits} permits`);
  }

  /**
   * 获取许可
   * 如果没有可用许可，将等待直到有许可释放
   *
   * @param timeout - 可选的超时时间（毫秒），超时后抛出错误
   * @returns Promise 在获取许可后 resolve
   * @throws 超时时抛出 Error
   */
  async acquire(timeout?: number): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      logger.debug(`Permit acquired immediately, remaining: ${this.permits}`);
      return;
    }

    logger.debug(`No permits available, queuing... (waiting: ${this.waiting.length})`);

    return new Promise((resolve, reject) => {
      const waiter: {
        resolve: () => void;
        reject: (error: Error) => void;
        timeoutId?: ReturnType<typeof setTimeout>;
      } = { resolve, reject };

      if (timeout && timeout > 0) {
        waiter.timeoutId = setTimeout(() => {
          const index = this.waiting.indexOf(waiter);
          if (index !== -1) {
            this.waiting.splice(index, 1);
            reject(new Error(`Semaphore acquire timeout after ${timeout}ms`));
          }
        }, timeout);
      }

      this.waiting.push(waiter);
    });
  }

  /**
   * 尝试立即获取许可（非阻塞）
   *
   * @returns true 如果成功获取许可，false 如果没有可用许可
   */
  tryAcquire(): boolean {
    if (this.permits > 0) {
      this.permits--;
      logger.debug(`Permit acquired (tryAcquire), remaining: ${this.permits}`);
      return true;
    }
    return false;
  }

  /**
   * 释放许可
   * 如果有等待的任务，将唤醒队列中的下一个
   */
  release(): void {
    if (this.waiting.length > 0) {
      const waiter = this.waiting.shift()!;
      if (waiter.timeoutId) {
        clearTimeout(waiter.timeoutId);
      }
      logger.debug(`Permit released to waiting task, remaining waiters: ${this.waiting.length}`);
      waiter.resolve();
    } else {
      this.permits++;
      if (this.permits > this.maxPermits) {
        logger.warn(`Semaphore over-released! Capping at max: ${this.maxPermits}`);
        this.permits = this.maxPermits;
      }
      logger.debug(`Permit released, available: ${this.permits}`);
    }
  }

  /**
   * 获取当前可用许可数
   */
  available(): number {
    return this.permits;
  }

  /**
   * 获取等待中的任务数
   */
  waitingCount(): number {
    return this.waiting.length;
  }

  /**
   * 获取当前正在使用的许可数
   */
  inUse(): number {
    return this.maxPermits - this.permits;
  }

  /**
   * 获取最大许可数
   */
  getMaxPermits(): number {
    return this.maxPermits;
  }

  /**
   * 清除所有等待的任务（用于关闭时）
   * @param error - 传递给等待者的错误信息
   */
  clearWaiting(error: string = 'Semaphore cleared'): void {
    const waiters = [...this.waiting];
    this.waiting = [];
    for (const waiter of waiters) {
      if (waiter.timeoutId) {
        clearTimeout(waiter.timeoutId);
      }
      waiter.reject(new Error(error));
    }
    logger.debug(`Cleared ${waiters.length} waiting tasks`);
  }
}
