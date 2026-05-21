// ============================================================================
// ConcurrencyLimiter - 自适应并发限流器（通用，按 provider 复用）
// ----------------------------------------------------------------------------
// 从 ZhipuProvider 内联的 ZhipuRateLimiter 抽出，供主模型路径与 quick model 路径
// 共享。命中限流（429/1302）后自适应降级 maxConcurrent，5 分钟无限流后逐步恢复。
// 只有在 PROVIDER_CONCURRENCY_LIMITS 中声明并发上限的 provider 才会被节流。
// ============================================================================

import { PROVIDER_CONCURRENCY_LIMITS } from '../../shared/constants';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ConcurrencyLimiter');

export class ConcurrencyLimiter {
  private queue: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  private activeRequests = 0;
  private maxConcurrent: number;
  private readonly initialMaxConcurrent: number;
  private readonly minInterval: number;
  private lastRequestTime = 0;
  private lastRateLimitTime = 0;

  constructor(
    private readonly label: string,
    maxConcurrent = 3,
    minIntervalMs = 200,
  ) {
    this.maxConcurrent = maxConcurrent;
    this.initialMaxConcurrent = maxConcurrent;
    this.minInterval = minIntervalMs;
  }

  /** 命中限流：降级并发上限（最低 1） */
  onRateLimit(): void {
    if (this.maxConcurrent > 1) {
      this.maxConcurrent--;
      this.lastRateLimitTime = Date.now();
      logger.warn(`[${this.label} 限流] 触发降级: maxConcurrent ${this.maxConcurrent + 1} → ${this.maxConcurrent}`);
    }
  }

  /** 成功一段时间（5 分钟）无限流后逐步恢复并发上限 */
  onSuccess(): void {
    if (this.maxConcurrent < this.initialMaxConcurrent && Date.now() - this.lastRateLimitTime > 5 * 60 * 1000) {
      this.maxConcurrent++;
      logger.info(`[${this.label} 限流] 恢复并发: maxConcurrent → ${this.maxConcurrent}`);
    }
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new Error('Request was cancelled');
    }

    return new Promise((resolve, reject) => {
      if (signal) {
        signal.addEventListener('abort', () => {
          const idx = this.queue.findIndex(item => item.resolve === resolve);
          if (idx >= 0) {
            this.queue.splice(idx, 1);
            reject(new Error('Request was cancelled while waiting'));
          }
        }, { once: true });
      }

      this.queue.push({ resolve, reject });
      this.tryNext();
    });
  }

  release(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this.tryNext();
  }

  private tryNext(): void {
    if (this.activeRequests >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.minInterval) {
      setTimeout(() => this.tryNext(), this.minInterval - timeSinceLastRequest);
      return;
    }

    const next = this.queue.shift();
    if (next) {
      this.activeRequests++;
      this.lastRequestTime = Date.now();
      logger.debug(`[${this.label} 限流] 请求开始, 当前并发: ${this.activeRequests}/${this.maxConcurrent}, 队列: ${this.queue.length}`);
      next.resolve();
    }
  }
}

// ----------------------------------------------------------------------------
// 按 provider 复用的限流器注册表
// ----------------------------------------------------------------------------

const limiters = new Map<string, ConcurrencyLimiter>();

/**
 * 获取某 provider 的并发限流器。仅对在 PROVIDER_CONCURRENCY_LIMITS 中声明了并发上限的
 * provider 返回实例；其余 provider 返回 null（调用方据此跳过节流）。
 *
 * 主模型路径（ZhipuProvider）与 quick model 路径（quickTask）共用同一实例，
 * 因此对同一 provider 的总并发会被一起约束。
 */
export function getProviderLimiter(provider: string | null | undefined): ConcurrencyLimiter | null {
  if (!provider) return null;
  const limit = PROVIDER_CONCURRENCY_LIMITS[provider];
  if (!limit) return null;

  let limiter = limiters.get(provider);
  if (!limiter) {
    limiter = new ConcurrencyLimiter(provider, limit.maxConcurrent, limit.minIntervalMs);
    limiters.set(provider, limiter);
  }
  return limiter;
}
