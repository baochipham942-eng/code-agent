// ============================================================================
// 统一瞬态错误重试策略
// 所有 Provider 共享，避免重复实现
// ============================================================================

import { logger } from './shared';
import { EventEmitter } from 'events';
import { getProviderHealthMonitor } from '../providerHealthMonitor';

/** Global retry event emitter for CLI visibility */
export const retryEvents = new EventEmitter();
retryEvents.setMaxListeners(5);

/**
 * 不可重试的错误模式 — 立即抛出，让 ModelRouter 走 fallback chain
 * 这些错误重试没有意义，只会浪费子 Agent 的超时预算
 */
const NON_RETRYABLE_PATTERNS = [
  'No available accounts',    // 503 但账号池耗尽，重试无意义
  'no available accounts',
  'invalid_api_key',          // 401 key 错误
  'Invalid token',            // 智谱 token 错误
  'authentication_error',     // 认证失败
  'insufficient_quota',       // 配额耗尽，跳过重试直接降级
  'INSUFFICIENT_BALANCE',     // 中转余额不足，重试无意义
  'Insufficient account balance',
  'insufficient balance',
  'payment required',         // 402 账户余额不足
  'model_not_allowed',        // 订阅不含模型，切换 provider/model 才可能恢复
  'subscription plan does not include access',
  'content_policy',           // 内容策略违规，重试无意义
  'content filter',           // 内容过滤
  'moderation',               // 内容审核拒绝
  'model deprecated',         // 模型已弃用，需切换
  'model decommissioned',     // 模型已下线
  'model retired',            // 模型已退役
  // context overflow（roadmap 1.9）：重试不可能成功，必须走压缩/降级
  'context_length_exceeded',
  'maximum context length',
  'context length',
  'prompt is too long',
  'input is too long',
];

/** 瞬态错误匹配模式（检查 message + code） */
const TRANSIENT_PATTERNS = [
  'socket hang up',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'TLS connection was established',
  'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
  'SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
  'bad record mac',
  'network socket disconnected',
  '流式响应无内容',
  'first-byte timeout',
  'stream inactivity timeout',
  'timeout of ',
  'empty artifact response',
  '502',
  '503',
  '504',
  '429',
];

const FALLBACK_ONLY_PATTERNS = [
  'reasoning loop detected',
  'repetitive reasoning',
  'model degeneration',
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

function includesAnyPattern(msg: string, patterns: string[]): boolean {
  const normalized = msg.toLowerCase();
  return patterns.some((pattern) => normalized.includes(pattern.toLowerCase()));
}

/**
 * 判断错误是否为瞬态错误（网络抖动、服务暂时不可用等）
 * 同时检查 message 文本和 error.code
 */
export function isTransientError(msg: string, errCode?: string): boolean {
  // 优先检查不可重试模式 — 即使包含 503 等瞬态码也不重试
  if (includesAnyPattern(msg, NON_RETRYABLE_PATTERNS)) return false;
  if (includesAnyPattern(msg, FALLBACK_ONLY_PATTERNS)) return false;
  if (includesAnyPattern(msg, TRANSIENT_PATTERNS)) return true;
  if (errCode && TRANSIENT_CODES.includes(errCode)) return true;
  return false;
}

/**
 * 判断错误是否为"致命"（账号/余额/内容策略等持久性错误）
 * 用于上层（如 TestRunner）在批量执行场景下做 circuit breaker，
 * 避免每个 case 都重复踩同一个持久性错误烧 API 费。
 */
export function isNonRetryableError(msg: string): boolean {
  return includesAnyPattern(msg, NON_RETRYABLE_PATTERNS);
}

/** retry-after 提示的上限，防止上游返回超长等待挂死调用方 */
const RETRY_AFTER_CAP_MS = 60_000;

/**
 * 从错误对象提取 retry-after 提示（毫秒）。三个来源按优先级：
 * 1. 结构化字段 err.retryAfterMs
 * 2. err.headers['retry-after']（秒）
 * 3. 错误消息文本（"try again in 20s" / "retry after 3 seconds" 等）
 * 提取不到返回 null。
 */
export function extractRetryAfterMs(err: unknown): number | null {
  const cap = (ms: number) => Math.min(Math.max(0, Math.round(ms)), RETRY_AFTER_CAP_MS);

  if (err && typeof err === 'object') {
    const structured = (err as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof structured === 'number' && Number.isFinite(structured) && structured > 0) {
      return cap(structured);
    }
    const headers = (err as { headers?: Record<string, unknown> }).headers;
    const headerValue = headers?.['retry-after'] ?? headers?.['Retry-After'];
    if (headerValue !== undefined) {
      const seconds = Number(headerValue);
      if (Number.isFinite(seconds) && seconds > 0) {
        return cap(seconds * 1000);
      }
    }
  }

  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const match = msg.match(
    /(?:retry[- ]?after|try again in)[:\s]*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)?/i,
  );
  if (match) {
    const value = Number(match[1]);
    const unit = (match[2] || 's').toLowerCase();
    if (Number.isFinite(value) && value > 0) {
      const ms = unit.startsWith('ms') || unit.startsWith('millisecond') ? value : value * 1000;
      return cap(ms);
    }
  }
  return null;
}

export interface RetryOptions {
  /** Provider 名称，用于日志 */
  providerName: string;
  /** 最大重试次数（不含首次） */
  maxRetries?: number;
  /** 基础延迟 ms，实际延迟 = baseDelay * 2^attempt（指数退避），retry-after 提示优先 */
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
  if (includesAnyPattern(msg, FALLBACK_ONLY_PATTERNS)) return true;
  // 不可重试但应该降级的错误（账号耗尽、key 无效等 → 换个 Provider 可能就好了）
  if (includesAnyPattern(msg, NON_RETRYABLE_PATTERNS)) return true;
  return isTransientError(msg, errCode);
}

/**
 * 标记需要跨 Provider 降级的 Error。Provider 抛此类错让上游路由切换下一个候选。
 */
export class FallbackEligibleError extends Error {
  readonly fallbackEligible = true;
  constructor(message: string) {
    super(message);
    this.name = 'FallbackEligibleError';
  }
}

export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const { providerName, maxRetries = 2, baseDelay = 1000, signal, onRetry } = options;
  const healthMonitor = getProviderHealthMonitor();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const startTime = Date.now();
    try {
      const result = await fn();
      healthMonitor.recordSuccess(providerName, Date.now() - startTime);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errCode = (err as NodeJS.ErrnoException).code;
      if (isTransientError(msg, errCode) && attempt < maxRetries && !signal?.aborted) {
        // 优先尊重上游的 retry-after 提示，否则指数退避（roadmap 1.9）
        const retryAfterMs = extractRetryAfterMs(err);
        const delay = retryAfterMs ?? baseDelay * 2 ** attempt;
        logger.warn(`[${providerName}] 瞬态错误 "${msg}" (code=${errCode}), ${delay}ms 后重试 (${attempt + 1}/${maxRetries})${retryAfterMs != null ? ' [retry-after]' : ''}`);
        // Notify caller about retry (for CLI visibility)
        const retryInfo = { provider: providerName, attempt: attempt + 1, maxRetries, delay, error: msg };
        onRetry?.(retryInfo);
        retryEvents.emit('retry', retryInfo);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      healthMonitor.recordFailure(providerName);
      throw err;
    }
  }
  throw new Error(`[${providerName}] 不应到达此处`);
}
