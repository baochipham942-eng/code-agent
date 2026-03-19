// ============================================================================
// 统一瞬态错误重试策略
// 所有 Provider 共享，避免重复实现
// ============================================================================

import { logger } from './shared';
import { EventEmitter } from 'events';

/** Global retry event emitter for CLI visibility */
export const retryEvents = new EventEmitter();
retryEvents.setMaxListeners(5);

/**
 * 不可重试的错误模式 — 立即抛出，让 ModelRouter 走 fallback chain
 * 这些错误重试没有意义，只会浪费子 Agent 的超时预算
 */
const NON_RETRYABLE_PATTERNS = [
  'No available accounts',    // 503 但账号池耗尽，重试无意义
  'invalid_api_key',          // 401 key 错误
  'Invalid token',            // 智谱 token 错误
  'authentication_error',     // 认证失败
];

/** 瞬态错误匹配模式（检查 message + code） */
const TRANSIENT_PATTERNS = [
  'socket hang up',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'TLS connection was established',
  'network socket disconnected',
  '流式响应无内容',
  'first-byte timeout',
  '502',
  '503',
  '504',
  '429',
];

/** 瞬态错误 code（Node.js ErrnoException.code） */
const TRANSIENT_CODES = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
];

/**
 * 判断错误是否为瞬态错误（网络抖动、服务暂时不可用等）
 * 同时检查 message 文本和 error.code
 */
export function isTransientError(msg: string, errCode?: string): boolean {
  // 优先检查不可重试模式 — 即使包含 503 等瞬态码也不重试
  if (NON_RETRYABLE_PATTERNS.some(p => msg.includes(p))) return false;
  if (TRANSIENT_PATTERNS.some(p => msg.includes(p))) return true;
  if (errCode && TRANSIENT_CODES.includes(errCode)) return true;
  return false;
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
  /** Optional callback when a retry is about to happen */
  onRetry?: (info: { provider: string; attempt: number; maxRetries: number; delay: number; error: string }) => void;
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
/**
 * 判断错误是否应该触发跨 Provider 降级
 *
 * 与 isTransientError 的区别：
 * - isTransientError: 控制"同 Provider 内是否重试" — No available accounts 返回 false（不重试）
 * - isFallbackEligible: 控制"是否切换到下一个 Provider" — No available accounts 返回 true（要降级）
 */
export function isFallbackEligible(msg: string, errCode?: string): boolean {
  // 不可重试但应该降级的错误（账号耗尽、key 无效等 → 换个 Provider 可能就好了）
  if (NON_RETRYABLE_PATTERNS.some(p => msg.includes(p))) return true;
  return isTransientError(msg, errCode);
}

export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const { providerName, maxRetries = 2, baseDelay = 1000, signal, onRetry } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errCode = (err as NodeJS.ErrnoException).code;
      if (isTransientError(msg, errCode) && attempt < maxRetries && !signal?.aborted) {
        const delay = baseDelay * (attempt + 1);
        logger.warn(`[${providerName}] 瞬态错误 "${msg}" (code=${errCode}), ${delay}ms 后重试 (${attempt + 1}/${maxRetries})`);
        // Notify caller about retry (for CLI visibility)
        const retryInfo = { provider: providerName, attempt: attempt + 1, maxRetries, delay, error: msg };
        onRetry?.(retryInfo);
        retryEvents.emit('retry', retryInfo);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`[${providerName}] 不应到达此处`);
}
