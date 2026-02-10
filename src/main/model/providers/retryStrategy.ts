// ============================================================================
// 统一瞬态错误重试策略
// 所有 Provider 共享，避免重复实现
// ============================================================================

import { logger } from './shared';

/** 瞬态错误匹配模式 */
const TRANSIENT_PATTERNS = [
  'socket hang up',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  '流式响应无内容',
  '502',
  '503',
  '504',
  '429',
];

/**
 * 判断错误是否为瞬态错误（网络抖动、服务暂时不可用等）
 */
export function isTransientError(msg: string): boolean {
  return TRANSIENT_PATTERNS.some(p => msg.includes(p));
}

export interface RetryOptions {
  /** Provider 名称，用于日志 */
  providerName: string;
  /** 最大重试次数（不含首次） */
  maxRetries?: number;
  /** 基础延迟 ms，实际延迟 = baseDelay * (attempt + 1) */
  baseDelay?: number;
  /** AbortSignal，取消时不重试 */
  signal?: AbortSignal;
}

/**
 * 带瞬态重试的异步执行器
 *
 * @example
 * ```ts
 * const result = await withTransientRetry(
 *   () => openAISSEStream({ ... }),
 *   { providerName: 'DeepSeek', maxRetries: 2 }
 * );
 * ```
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const { providerName, maxRetries = 2, baseDelay = 1000, signal } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isTransientError(msg) && attempt < maxRetries && !signal?.aborted) {
        const delay = baseDelay * (attempt + 1);
        logger.warn(`[${providerName}] 瞬态错误 "${msg}", ${delay}ms 后重试 (${attempt + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`[${providerName}] 不应到达此处`);
}
