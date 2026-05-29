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
  private initialMaxConcurrent: number;
  private minInterval: number;
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

  /**
   * 用户在模型配置页改了并发上限后热更新基线（无需重启）。
   * 重置 maxConcurrent 到新基线（放弃当前的临时降级状态），上限提高时立即放行排队请求。
   */
  updateLimits(maxConcurrent: number, minIntervalMs?: number): void {
    const newMax = Math.max(1, Math.floor(maxConcurrent));
    if (newMax !== this.initialMaxConcurrent) {
      logger.info(`[${this.label} 限流] 配置更新: maxConcurrent ${this.initialMaxConcurrent} → ${newMax}`);
      this.initialMaxConcurrent = newMax;
      this.maxConcurrent = newMax;
    }
    if (minIntervalMs !== undefined && minIntervalMs >= 0) {
      this.minInterval = minIntervalMs;
    }
    this.tryNext();
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

// 用户在模型配置页填写的 per-provider 并发覆盖（优先级高于 PROVIDER_CONCURRENCY_LIMITS 出厂默认）。
// 由 configService 在启动加载 + 用户保存设置时通过 setProviderConcurrencyOverrides 推入。
const overrides = new Map<string, { maxConcurrent: number; minIntervalMs: number }>();

/** 解析某 provider 的有效并发限额：用户覆盖 > 出厂默认 > 不限流(null)。 */
function resolveLimit(provider: string): { maxConcurrent: number; minIntervalMs: number } | null {
  const ov = overrides.get(provider);
  if (ov) return ov;
  const def = PROVIDER_CONCURRENCY_LIMITS[provider];
  if (def && def.maxConcurrent > 0) return def;
  return null;
}

/**
 * 用模型配置页的用户设置覆盖各 provider 的并发上限。
 * 整表替换语义：未在 map 中出现的 provider 回落到出厂默认。
 * 对已存在的 limiter 实例做热更新（值变了就改、变成不限流就驱逐），无需重启。
 */
export function setProviderConcurrencyOverrides(
  map: Record<string, { maxConcurrent: number; minIntervalMs?: number }>,
): void {
  overrides.clear();
  for (const [provider, cfg] of Object.entries(map)) {
    if (cfg && Number.isFinite(cfg.maxConcurrent) && cfg.maxConcurrent > 0) {
      overrides.set(provider, {
        maxConcurrent: Math.floor(cfg.maxConcurrent),
        minIntervalMs: cfg.minIntervalMs ?? PROVIDER_CONCURRENCY_LIMITS[provider]?.minIntervalMs ?? 200,
      });
    }
  }
  // 热更新已实例化的 limiter
  for (const provider of Array.from(limiters.keys())) {
    const eff = resolveLimit(provider);
    if (!eff) {
      limiters.delete(provider); // 既无用户覆盖也无出厂默认 → 不再限流
    } else {
      limiters.get(provider)!.updateLimits(eff.maxConcurrent, eff.minIntervalMs);
    }
  }
}

/**
 * 获取某 provider 的并发限流器。仅对有「有效并发限额」（用户覆盖或出厂默认）的
 * provider 返回实例；其余 provider 返回 null（调用方据此跳过节流）。
 *
 * 主模型路径（aiSdkAdapter / ZhipuProvider）与 quick model 路径（quickTask）共用同一实例，
 * 因此对同一 provider 的总并发会被一起约束。
 */
export function getProviderLimiter(provider: string | null | undefined): ConcurrencyLimiter | null {
  if (!provider) return null;
  const limit = resolveLimit(provider);
  if (!limit) return null;

  let limiter = limiters.get(provider);
  if (!limiter) {
    limiter = new ConcurrencyLimiter(provider, limit.maxConcurrent, limit.minIntervalMs);
    limiters.set(provider, limiter);
  }
  return limiter;
}

/**
 * 解析某 provider 的有效并发上限（用户覆盖 > 出厂默认），无限额返回 null。
 * 供 scriptRuntime 的 ConcurrencyGate 做 provider-aware 全局槽分配——防止单个 provider
 * 占满全局并发槽饿死其他 provider。与 inferenceViaAiSdk 内部 limiter 互补：gate 只做全局
 * 公平分配、按此值卡每 provider 在途数，绝不重复 acquire provider limiter（那会双重计数）。
 */
export function getEffectiveProviderConcurrency(provider: string | null | undefined): number | null {
  if (!provider) return null;
  const limit = resolveLimit(provider);
  return limit ? limit.maxConcurrent : null;
}
