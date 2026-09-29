// ============================================================================
// Retry Strategy Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  abortableSleep,
  computeRetryBackoffMs,
  extractRetryAfterMs,
  isCancellationError,
  describeFallbackError,
  isFallbackEligible,
  isRetryableModelCallError,
  isTransientError,
  withTransientRetry,
  createRetryFingerprintScope,
} from '../../../src/host/model/providers/retryStrategy';
import { classifyError } from '../../../src/host/model/errorClassifier';
import { getProviderHealthMonitor } from '../../../src/host/model/providerHealthMonitor';

// Mock logger to suppress console output during tests
vi.mock('../../../src/host/model/providers/shared', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('Retry Strategy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // isTransientError
  // --------------------------------------------------------------------------
  describe('isTransientError', () => {
    describe('message-based detection', () => {
      it('should detect socket hang up', () => {
        expect(isTransientError('socket hang up')).toBe(true);
      });

      it('should detect ECONNRESET', () => {
        expect(isTransientError('read ECONNRESET')).toBe(true);
      });

      it('should detect ECONNREFUSED', () => {
        expect(isTransientError('connect ECONNREFUSED 127.0.0.1:3000')).toBe(true);
      });

      it('should detect ETIMEDOUT', () => {
        expect(isTransientError('connect ETIMEDOUT')).toBe(true);
      });

      it('should detect EPIPE', () => {
        expect(isTransientError('write EPIPE')).toBe(true);
      });

      it('should detect TLS errors', () => {
        expect(isTransientError('TLS connection was established')).toBe(true);
      });

      it('should detect TLS bad record MAC failures', () => {
        expect(isTransientError('ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC')).toBe(true);
        expect(isTransientError('write: ssl routines: SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC')).toBe(true);
        expect(isTransientError('tlsv1 alert bad record mac')).toBe(true);
      });

      it('should detect network socket disconnected', () => {
        expect(isTransientError('network socket disconnected')).toBe(true);
      });

      it('should detect empty stream response', () => {
        expect(isTransientError('流式响应无内容')).toBe(true);
      });

      it('should detect empty artifact response', () => {
        expect(isTransientError('empty artifact response from xiaomi/mimo-v2.5-pro')).toBe(true);
      });

      it('should detect axios timeout errors', () => {
        expect(isTransientError('Network request failed: timeout of 45000ms exceeded')).toBe(true);
      });

      it('should detect HTTP 502', () => {
        expect(isTransientError('502 Bad Gateway')).toBe(true);
      });

      it('should detect HTTP 503', () => {
        expect(isTransientError('503 Service Unavailable')).toBe(true);
      });

      it('should detect HTTP 504', () => {
        expect(isTransientError('504 Gateway Timeout')).toBe(true);
      });

      it('should detect HTTP 429 rate limit', () => {
        expect(isTransientError('429 Too Many Requests')).toBe(true);
      });
    });

    describe('code-based detection', () => {
      it('should detect ECONNRESET code', () => {
        expect(isTransientError('unknown error', 'ECONNRESET')).toBe(true);
      });

      it('should detect ECONNREFUSED code', () => {
        expect(isTransientError('', 'ECONNREFUSED')).toBe(true);
      });

      it('should detect ETIMEDOUT code', () => {
        expect(isTransientError('', 'ETIMEDOUT')).toBe(true);
      });

      it('should detect EPIPE code', () => {
        expect(isTransientError('', 'EPIPE')).toBe(true);
      });

      it('should detect ENOTFOUND code', () => {
        expect(isTransientError('', 'ENOTFOUND')).toBe(true);
      });

      it('should detect EAI_AGAIN code', () => {
        expect(isTransientError('', 'EAI_AGAIN')).toBe(true);
      });
    });

    describe('non-transient errors', () => {
      it('should not match normal errors', () => {
        expect(isTransientError('Cannot read properties of undefined')).toBe(false);
      });

      it('should not match auth errors', () => {
        expect(isTransientError('401 Unauthorized')).toBe(false);
      });

      it('should not retry provider account exhaustion errors', () => {
        expect(isTransientError('No available accounts: no available accounts')).toBe(false);
        expect(isTransientError('{"code":"INSUFFICIENT_BALANCE","message":"Insufficient account balance"}')).toBe(false);
      });

      it('should not match 400 errors', () => {
        expect(isTransientError('400 Bad Request')).toBe(false);
      });

      it('should not match unknown codes', () => {
        expect(isTransientError('error', 'ERR_INVALID_ARG_TYPE')).toBe(false);
      });

      it('should handle no code', () => {
        expect(isTransientError('some error')).toBe(false);
      });

      it('should not retry model reasoning degeneration locally', () => {
        expect(isTransientError('[Xiaomi] reasoning loop detected: repeated "x" 6 times')).toBe(false);
      });
    });
  });

  describe('isCancellationError', () => {
    it('识别明确的取消形状', () => {
      const abortError = new Error('request stopped');
      abortError.name = 'AbortError';
      const codeError = new Error('request stopped') as NodeJS.ErrnoException;
      codeError.code = 'ABORT_ERR';

      expect(isCancellationError(abortError)).toBe(true);
      expect(isCancellationError(codeError)).toBe(true);
      expect(isCancellationError(new Error('canceled'))).toBe(true);
      expect(isCancellationError({ message: 'aborted' })).toBe(true);
    });

    it('signal 已 abort 时识别为取消', () => {
      const controller = new AbortController();
      controller.abort();

      expect(isCancellationError(new Error('ordinary failure'), controller.signal)).toBe(true);
    });

    it('不把包含 cancel 字样的业务错误误判为取消', () => {
      expect(isCancellationError(new Error('user cancelled the previous request'))).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // isFallbackEligible
  // --------------------------------------------------------------------------
  describe('isFallbackEligible', () => {
    it('should fall back on transient errors', () => {
      expect(isFallbackEligible('read ECONNRESET')).toBe(true);
      expect(isFallbackEligible('503 Service Unavailable')).toBe(true);
      expect(isFallbackEligible('ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC')).toBe(true);
    });

    it('should fall back on non-retryable provider capacity and billing errors', () => {
      expect(isFallbackEligible('No available accounts: no available accounts')).toBe(true);
      expect(isFallbackEligible('{"code":"INSUFFICIENT_BALANCE","message":"Insufficient account balance"}')).toBe(true);
      expect(isFallbackEligible('Your subscription plan does not include access to model: glm-4.7-flash')).toBe(true);
      expect(isFallbackEligible('model_not_allowed')).toBe(true);
    });

    it('should fall back on model reasoning degeneration', () => {
      expect(isFallbackEligible('[Xiaomi] reasoning loop detected: repeated "x" 6 times')).toBe(true);
    });

    it('should not fall back on ordinary bad requests', () => {
      expect(isFallbackEligible('400 Bad Request')).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // withTransientRetry
  // --------------------------------------------------------------------------
  describe('withTransientRetry', () => {
    it('should return result on first success', async () => {
      const fn = vi.fn().mockResolvedValue('success');
      const result = await withTransientRetry(fn, {
        providerName: 'test',
        maxRetries: 2,
        baseDelay: 1,
      });
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on transient error and succeed', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockResolvedValue('recovered');

      const result = await withTransientRetry(fn, {
        providerName: 'test',
        maxRetries: 2,
        baseDelay: 1,
      });
      expect(result).toBe('recovered');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should retry up to maxRetries times', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValue('finally');

      const result = await withTransientRetry(fn, {
        providerName: 'test',
        maxRetries: 2,
        baseDelay: 1,
      });
      expect(result).toBe('finally');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should throw after exhausting retries', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('ECONNRESET'));

      await expect(
        withTransientRetry(fn, {
          providerName: 'test',
          maxRetries: 2,
          baseDelay: 1,
        })
      ).rejects.toThrow('ECONNRESET');

      // 1 initial + 2 retries = 3 calls
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should not retry non-transient errors', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('401 Unauthorized'));

      await expect(
        withTransientRetry(fn, {
          providerName: 'test',
          maxRetries: 2,
          baseDelay: 1,
        })
      ).rejects.toThrow('401 Unauthorized');

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should not retry when signal is aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      const providerName = 'retry-already-aborted-health-test';

      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValue('success');

      await expect(
        withTransientRetry(fn, {
          providerName,
          maxRetries: 2,
          baseDelay: 1,
          signal: controller.signal,
        })
      ).rejects.toThrow('ECONNRESET');

      expect(fn).toHaveBeenCalledTimes(1);
      expect(getProviderHealthMonitor().getHealth(providerName)).toBeNull();
    });

    it('普通失败仍然照常记入健康度', async () => {
      const providerName = 'retry-ordinary-failure-health-test';
      const fn = vi.fn().mockRejectedValue(new Error('401 Unauthorized'));

      await expect(withTransientRetry(fn, { providerName, maxRetries: 0 })).rejects.toThrow('401 Unauthorized');

      expect(getProviderHealthMonitor().getHealth(providerName)).toMatchObject({
        status: 'unavailable',
        errorRate: 1,
        consecutiveErrors: 1,
      });
    });

    it('包含 cancel 字样的业务错误仍然照常记入健康度', async () => {
      const providerName = 'retry-cancel-word-business-error-health-test';
      const fn = vi.fn().mockRejectedValue(new Error('user cancelled the previous request'));

      await expect(withTransientRetry(fn, { providerName, maxRetries: 0 })).rejects.toThrow(
        'user cancelled the previous request',
      );

      expect(getProviderHealthMonitor().getHealth(providerName)).toMatchObject({
        status: 'unavailable',
        errorRate: 1,
        consecutiveErrors: 1,
      });
    });

    it('should retry with transient error code', async () => {
      const err = new Error('connection error') as NodeJS.ErrnoException;
      err.code = 'ENOTFOUND';

      const fn = vi.fn()
        .mockRejectedValueOnce(err)
        .mockResolvedValue('resolved');

      const result = await withTransientRetry(fn, {
        providerName: 'test',
        maxRetries: 1,
        baseDelay: 1,
      });
      expect(result).toBe('resolved');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should retry TLS bad record MAC failures', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC'))
        .mockResolvedValue('resolved');

      const result = await withTransientRetry(fn, {
        providerName: 'test',
        maxRetries: 1,
        baseDelay: 1,
      });
      expect(result).toBe('resolved');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should use default options', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockResolvedValue('ok');

      const result = await withTransientRetry(fn, {
        providerName: 'test',
        baseDelay: 1,
      });
      expect(result).toBe('ok');
    });

    it('uses exponential backoff (baseDelay * 2^attempt) with ±25% jitter', async () => {
      const delays: number[] = [];
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockResolvedValue('ok');

      await withTransientRetry(fn, {
        providerName: 'test',
        maxRetries: 2,
        baseDelay: 4,
        onRetry: (info) => delays.push(info.delay),
      });
      // 指数基数 4→8，jitter ±25%：落在 [3,5] / [6,10] 区间，且第二次的基数严格大于第一次
      expect(delays).toHaveLength(2);
      expect(delays[0]).toBeGreaterThanOrEqual(3);
      expect(delays[0]).toBeLessThanOrEqual(5);
      expect(delays[1]).toBeGreaterThanOrEqual(6);
      expect(delays[1]).toBeLessThanOrEqual(10);
    });

    it('prefers retry-after hint from the error over backoff', async () => {
      const delays: number[] = [];
      const err = new Error('429 rate limited') as Error & { retryAfterMs?: number };
      err.retryAfterMs = 37;
      const fn = vi.fn()
        .mockRejectedValueOnce(err)
        .mockResolvedValue('ok');

      await withTransientRetry(fn, {
        providerName: 'test',
        maxRetries: 1,
        baseDelay: 1,
        onRetry: (info) => delays.push(info.delay),
      });
      expect(delays).toEqual([37]);
    });

    it('退避等待期间 signal abort 时不影响健康度', async () => {
      const controller = new AbortController();
      const providerName = 'retry-backoff-aborted-health-test';
      const err = new Error('429 rate limited') as Error & { retryAfterMs?: number };
      err.retryAfterMs = 60_000;
      const fn = vi.fn().mockRejectedValue(err);

      await expect(withTransientRetry(fn, {
        providerName,
        maxRetries: 2,
        signal: controller.signal,
        onRetry: () => controller.abort(),
      })).rejects.toThrow('429 rate limited');

      expect(fn).toHaveBeenCalledTimes(1);
      expect(getProviderHealthMonitor().getHealth(providerName)).toBeNull();
    });
  });

    it('aborts the retry-after sleep when the signal fires (codex audit R1)', async () => {
      const controller = new AbortController();
      const err = new Error('429 rate limited') as Error & { retryAfterMs?: number };
      err.retryAfterMs = 60_000;
      const fn = vi.fn().mockRejectedValue(err);

      const start = Date.now();
      await expect(
        withTransientRetry(fn, {
          providerName: 'test',
          maxRetries: 2,
          baseDelay: 1,
          signal: controller.signal,
          onRetry: () => controller.abort(),
        }),
      ).rejects.toThrow('429 rate limited');
      // 不应等满 60s 的 retry-after
      expect(Date.now() - start).toBeLessThan(2000);
      expect(fn).toHaveBeenCalledTimes(1);
    });

  // --------------------------------------------------------------------------
  // extractRetryAfterMs
  // --------------------------------------------------------------------------
  describe('extractRetryAfterMs', () => {
    it('reads Headers-like objects with a get() method (codex audit R1)', () => {
      const err = new Error('429') as Error & { headers?: { get: (k: string) => string | null } };
      err.headers = { get: (k: string) => (k.toLowerCase() === 'retry-after' ? '7' : null) };
      expect(extractRetryAfterMs(err)).toBe(7000);
    });

    it('parses HTTP-date retry-after values (codex audit R1)', () => {
      const err = new Error('429') as Error & { headers?: Record<string, string> };
      err.headers = { 'retry-after': new Date(Date.now() + 5000).toUTCString() };
      const ms = extractRetryAfterMs(err);
      expect(ms).not.toBeNull();
      expect(ms!).toBeGreaterThan(0);
      expect(ms!).toBeLessThanOrEqual(6000);
    });
    it('reads structured retryAfterMs field', () => {
      const err = new Error('429') as Error & { retryAfterMs?: number };
      err.retryAfterMs = 1234;
      expect(extractRetryAfterMs(err)).toBe(1234);
    });

    it('reads retry-after header in seconds', () => {
      const err = new Error('429') as Error & { headers?: Record<string, string> };
      err.headers = { 'retry-after': '5' };
      expect(extractRetryAfterMs(err)).toBe(5000);
    });

    it('parses "try again in Ns" from message', () => {
      expect(extractRetryAfterMs(new Error('Rate limit reached. Please try again in 20s.'))).toBe(20_000);
    });

    it('parses "retry after N seconds" from message', () => {
      expect(extractRetryAfterMs(new Error('429 Too Many Requests, retry after 3 seconds'))).toBe(3000);
    });

    it('parses milliseconds unit from message', () => {
      expect(extractRetryAfterMs(new Error('Please try again in 500ms'))).toBe(500);
    });

    it('caps the hint at 60s', () => {
      const err = new Error('429') as Error & { headers?: Record<string, string> };
      err.headers = { 'retry-after': '600' };
      expect(extractRetryAfterMs(err)).toBe(60_000);
    });

    it('returns null when no hint present', () => {
      expect(extractRetryAfterMs(new Error('socket hang up'))).toBeNull();
      expect(extractRetryAfterMs('plain string error')).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // context overflow 不重试（roadmap 1.9：4xx/context overflow 收敛到不可重试）
  // --------------------------------------------------------------------------
  describe('context overflow classification', () => {
    it.each([
      'context_length_exceeded',
      "This model's maximum context length is 8192 tokens",
      'prompt is too long: 210000 tokens > 200000 maximum',
      'input is too long for requested model',
    ])('treats "%s" as non-retryable', (msg) => {
      expect(isTransientError(msg)).toBe(false);
    });
  });

  describe('image payload overflow classification', () => {
    it.each([
      'Claude API (413): request_too_large',
      'Too many images in request: 101 > 100',
    ])('does not retry and allows provider fallback for "%s"', (msg) => {
      expect(isTransientError(msg)).toBe(false);
      expect(isFallbackEligible(msg)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // abortableSleep（codex audit R2 对称应用：导出供 aiSdkAdapter/modelRouter 复用）
  // --------------------------------------------------------------------------
  describe('abortableSleep', () => {
    it('abort 时立即醒来，不等满延迟', async () => {
      vi.useFakeTimers();
      try {
        const controller = new AbortController();
        let resolved = false;
        const sleep = abortableSleep(60_000, controller.signal).then(() => { resolved = true; });
        controller.abort();
        // fake timers 下不推时间：只有 abort 监听能唤醒它
        await sleep;
        expect(resolved).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('未 abort 时按延迟正常醒来', async () => {
      vi.useFakeTimers();
      try {
        let resolved = false;
        const sleep = abortableSleep(1_000).then(() => { resolved = true; });
        await vi.advanceTimersByTimeAsync(999);
        expect(resolved).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await sleep;
        expect(resolved).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('signal 已 aborted 时同步直通', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(abortableSleep(60_000, controller.signal)).resolves.toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // isRetryableModelCallError（模型调用层统一可重试判定）
  // --------------------------------------------------------------------------
  describe('isRetryableModelCallError', () => {
    it.each([429, 500, 502, 503, 504])('HTTP %i（结构化 status）可重试', (status) => {
      const err = Object.assign(new Error('gateway hiccup'), { status });
      expect(isRetryableModelCallError(err)).toBe(true);
    });

    it.each([400, 401, 403, 404, 413])('HTTP %i（确定性错误）不重试', (status) => {
      const err = Object.assign(new Error('deterministic failure'), { status });
      expect(isRetryableModelCallError(err)).toBe(false);
    });

    it('网关 504 抖动但 message 不含状态码数字（tokenrhythm 实测形态）可重试', () => {
      // AI SDK APICallError：message 只有文案，status 在结构化字段上
      const err = Object.assign(new Error('Gateway Timeout'), { status: 504 });
      expect(isRetryableModelCallError(err)).toBe(true);
    });

    it('auth 失败（401 + invalid_api_key 文案）不重试', () => {
      const err = Object.assign(new Error('invalid_api_key'), { status: 401 });
      expect(isRetryableModelCallError(err)).toBe(false);
    });

    it('429 但余额耗尽文案（NON_RETRYABLE 护栏优先）不重试', () => {
      const err = Object.assign(new Error('429 insufficient balance'), { status: 429 });
      expect(isRetryableModelCallError(err)).toBe(false);
    });

    it.each([402, 409, 422])('HTTP %i（4xx 显式护栏，AI SDK statusCode 字段）不重试', (statusCode) => {
      // AI SDK APICallError 的状态挂在 statusCode 上；文案未收录也不能漏进重试
      const err = Object.assign(new Error('upstream rejected'), { statusCode });
      expect(isRetryableModelCallError(err)).toBe(false);
    });

    it('429 + 中文欠费文案（国内 provider 形态）不重试', () => {
      const err = Object.assign(new Error('429 Too Many Requests: 账户已欠费'), { status: 429 });
      expect(isRetryableModelCallError(err)).toBe(false);
      expect(isRetryableModelCallError(new Error('余额不足，请充值'))).toBe(false);
      expect(isRetryableModelCallError(new Error('鉴权失败'))).toBe(false);
    });

    it('网络瞬断（无 status）靠 message/code 判定可重试', () => {
      expect(isRetryableModelCallError(new Error('socket hang up'))).toBe(true);
      const reset = new Error('read ECONNRESET') as NodeJS.ErrnoException;
      reset.code = 'ECONNRESET';
      expect(isRetryableModelCallError(reset)).toBe(true);
      const timeout = new Error('timeout of 90000ms exceeded');
      expect(isRetryableModelCallError(timeout)).toBe(true);
    });

    it('普通业务错误不重试', () => {
      expect(isRetryableModelCallError(new Error('Cannot read properties of undefined'))).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // computeRetryBackoffMs（指数退避 1s→2s→4s→8s + jitter，封顶 16s）
  // --------------------------------------------------------------------------
  describe('computeRetryBackoffMs', () => {
    it('指数基数按 attempt 翻倍（jitter ±25% 内）', () => {
      for (let i = 0; i < 50; i++) {
        expect(computeRetryBackoffMs(0, 1000)).toBeGreaterThanOrEqual(750);
        expect(computeRetryBackoffMs(0, 1000)).toBeLessThanOrEqual(1250);
        expect(computeRetryBackoffMs(1, 1000)).toBeGreaterThanOrEqual(1500);
        expect(computeRetryBackoffMs(1, 1000)).toBeLessThanOrEqual(2500);
        expect(computeRetryBackoffMs(2, 1000)).toBeGreaterThanOrEqual(3000);
        expect(computeRetryBackoffMs(2, 1000)).toBeLessThanOrEqual(5000);
        expect(computeRetryBackoffMs(3, 1000)).toBeGreaterThanOrEqual(6000);
        expect(computeRetryBackoffMs(3, 1000)).toBeLessThanOrEqual(10_000);
      }
    });

    it('高 attempt 封顶 16s', () => {
      for (let i = 0; i < 20; i++) {
        expect(computeRetryBackoffMs(10, 1000)).toBeLessThanOrEqual(16_000);
      }
    });

    it('retry-after 提示优先且不加 jitter', () => {
      expect(computeRetryBackoffMs(0, 1000, 3000)).toBe(3000);
    });
  });

  // --------------------------------------------------------------------------
  // maxTimeoutRetries（issue #1989：客户端超时驱动的重试单独封顶，不与秒级瞬态共享预算）
  // --------------------------------------------------------------------------
  describe('withTransientRetry — maxTimeoutRetries', () => {
    const timeoutError = () => Object.assign(
      new Error('timeout of 300000ms exceeded'),
      { code: 'INFERENCE_REQUEST_TIMEOUT' },
    );
    const isTimeoutError = (err: unknown) =>
      (err as NodeJS.ErrnoException | null)?.code === 'INFERENCE_REQUEST_TIMEOUT';

    it('超时错误到 maxTimeoutRetries 即放弃（1+2 次调用），不烧满 maxRetries', async () => {
      const fn = vi.fn().mockRejectedValue(timeoutError());
      await expect(withTransientRetry(fn, {
        providerName: 'test',
        maxRetries: 4,
        baseDelay: 1,
        isTimeoutError,
        maxTimeoutRetries: 2,
      })).rejects.toThrow('timeout of 300000ms exceeded');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('普通瞬态错误不受 maxTimeoutRetries 影响，仍按 maxRetries 重试', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockRejectedValueOnce(new Error('502 Bad Gateway'))
        .mockResolvedValue('recovered');
      const result = await withTransientRetry(fn, {
        providerName: 'test',
        maxRetries: 4,
        baseDelay: 1,
        isTimeoutError,
        maxTimeoutRetries: 2,
      });
      expect(result).toBe('recovered');
      expect(fn).toHaveBeenCalledTimes(4);
    });

    it('超时与普通瞬态混合时只有超时计入超时预算', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(timeoutError())
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockRejectedValueOnce(timeoutError())
        .mockRejectedValueOnce(timeoutError());
      await expect(withTransientRetry(fn, {
        providerName: 'test',
        maxRetries: 4,
        baseDelay: 1,
        isTimeoutError,
        maxTimeoutRetries: 2,
      })).rejects.toThrow('timeout of 300000ms exceeded');
      // 3 次超时错误里前 2 次触发重试，第 3 次预算耗尽直抛；中间瞬态不占超时预算
      expect(fn).toHaveBeenCalledTimes(4);
    });

    it('缺省 maxTimeoutRetries 维持旧行为（maxRetries 全权）', async () => {
      // 交替两种超时文案，同指纹熔断不会把「预算仍是 maxRetries」收成 3 次。
      const primary = () => Object.assign(
        new Error('timeout of 300000ms exceeded'),
        { code: 'INFERENCE_REQUEST_TIMEOUT' },
      );
      const other = () => new Error('first-byte timeout');
      const fn = vi.fn()
        .mockRejectedValueOnce(primary())
        .mockRejectedValueOnce(other())
        .mockRejectedValueOnce(primary())
        .mockRejectedValueOnce(other())
        .mockRejectedValue(primary());
      await expect(withTransientRetry(fn, {
        providerName: 'test',
        maxRetries: 4,
        baseDelay: 1,
      })).rejects.toThrow('timeout of 300000ms exceeded');
      expect(fn).toHaveBeenCalledTimes(5);
    });
  });

  describe('withTransientRetry — repeated retryable fingerprint', () => {
    const rateLimit = (id: string) => Object.assign(
      new Error(`429 rate limited req_${id}`),
      { status: 429 },
    );
    const gateway = (id: string) => Object.assign(
      new Error(`502 Bad Gateway req_${id}`),
      { status: 502 },
    );
    const connectionReset = () => Object.assign(
      new Error('Connection error: ECONNRESET'),
      { code: 'ECONNRESET' },
    );

    it('stops when the same rate-limit fingerprint repeats to the threshold', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(rateLimit('a'))
        .mockRejectedValueOnce(rateLimit('b'))
        .mockRejectedValueOnce(rateLimit('c'))
        .mockResolvedValue('should-not-run');
      await expect(withTransientRetry(fn, {
        providerName: 'fingerprint-rate-limit',
        maxRetries: 5,
        baseDelay: 1,
      })).rejects.toMatchObject({
        name: 'RepeatedRetryableFingerprintError',
        streak: 3,
      });
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('does not trip when the retryable status alternates', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(rateLimit('a'))
        .mockRejectedValueOnce(gateway('b'))
        .mockRejectedValueOnce(rateLimit('c'))
        .mockResolvedValue('recovered');
      const result = await withTransientRetry(fn, {
        providerName: 'fingerprint-alternating',
        maxRetries: 5,
        baseDelay: 1,
      });
      expect(result).toBe('recovered');
      expect(fn).toHaveBeenCalledTimes(4);
    });

    it('resets the streak when a body or a tool call arrives, and keeps it for empty text', async () => {
      const scope = createRetryFingerprintScope();
      const options = {
        providerName: 'fingerprint-reset',
        maxRetries: 5,
        baseDelay: 1,
        fingerprintScope: scope,
      };
      const body = vi.fn()
        .mockRejectedValueOnce(rateLimit('a'))
        .mockRejectedValueOnce(rateLimit('b'))
        .mockResolvedValue({ content: 'partial body' });
      await expect(withTransientRetry(body, options)).resolves.toEqual({ content: 'partial body' });

      const tools = vi.fn()
        .mockRejectedValueOnce(rateLimit('c'))
        .mockRejectedValueOnce(rateLimit('d'))
        .mockResolvedValue({ toolCalls: [{ id: 'call-1', name: 'Read' }] });
      await expect(withTransientRetry(tools, options)).resolves.toEqual({
        toolCalls: [{ id: 'call-1', name: 'Read' }],
      });

      const blank = vi.fn()
        .mockRejectedValueOnce(rateLimit('e'))
        .mockRejectedValueOnce(rateLimit('f'))
        .mockResolvedValue({ content: '   ', toolCalls: [] });
      await expect(withTransientRetry(blank, options)).resolves.toEqual({ content: '   ', toolCalls: [] });

      const tripped = vi.fn().mockRejectedValue(rateLimit('g'));
      await expect(withTransientRetry(tripped, options)).rejects.toMatchObject({
        name: 'RepeatedRetryableFingerprintError',
        streak: 3,
      });
      expect(tripped).toHaveBeenCalledTimes(1);
    });

    it('clears the streak on a non-retryable error', async () => {
      const scope = createRetryFingerprintScope();
      const options = {
        providerName: 'fingerprint-non-retryable',
        maxRetries: 5,
        baseDelay: 1,
        fingerprintScope: scope,
      };
      const denied = vi.fn()
        .mockRejectedValueOnce(rateLimit('a'))
        .mockRejectedValueOnce(rateLimit('b'))
        .mockRejectedValueOnce(Object.assign(new Error('401 Unauthorized'), { status: 401 }));
      await expect(withTransientRetry(denied, options)).rejects.toThrow('401 Unauthorized');

      const recovered = vi.fn()
        .mockRejectedValueOnce(rateLimit('c'))
        .mockRejectedValueOnce(rateLimit('d'))
        .mockResolvedValue('ok');
      await expect(withTransientRetry(recovered, options)).resolves.toBe('ok');
      expect(recovered).toHaveBeenCalledTimes(3);
    });

    it('classifies the tripped error like the underlying status and does not retry the wrapper', async () => {
      const cases = [
        { status: 502, message: '502 Bad Gateway', expected: 'unavailable' },
        { status: 429, message: '429 Too Many Requests', expected: 'rate_limit' },
      ] as const;
      for (const { status, message, expected } of cases) {
        const underlying = Object.assign(new Error(message), { status });
        const fn = vi.fn().mockRejectedValue(underlying);
        const tripped = await withTransientRetry(fn, {
          providerName: `fingerprint-class-${status}`,
          maxRetries: 4,
          baseDelay: 1,
        }).then(
          () => Promise.reject(new Error('expected the fingerprint breaker')),
          (err: unknown) => err,
        );
        expect(fn).toHaveBeenCalledTimes(3);
        expect(isRetryableModelCallError(tripped)).toBe(false);
        expect(isFallbackEligible((tripped as Error).message)).toBe(false);
        expect(tripped).toMatchObject({ status, cause: underlying });
        expect(classifyError(tripped)).toBe(expected);
        expect(classifyError(tripped)).toBe(classifyError(underlying));
        const described = describeFallbackError(tripped);
        expect(isFallbackEligible(described.message, described.code)).toBe(true);
      }
    });

    it('lets the next provider retry the same fingerprint after the breaker trips', async () => {
      const scope = createRetryFingerprintScope();
      const primary = vi.fn().mockRejectedValue(rateLimit('a'));
      await expect(withTransientRetry(primary, {
        providerName: 'fingerprint-primary',
        maxRetries: 4,
        baseDelay: 1,
        fingerprintScope: scope,
      })).rejects.toMatchObject({
        name: 'RepeatedRetryableFingerprintError',
        streak: 3,
      });
      expect(primary).toHaveBeenCalledTimes(3);

      const fallback = vi.fn()
        .mockRejectedValueOnce(rateLimit('b'))
        .mockResolvedValue('fallback-ok');
      await expect(withTransientRetry(fallback, {
        providerName: 'fingerprint-fallback',
        maxRetries: 4,
        baseDelay: 1,
        fingerprintScope: scope,
      })).resolves.toBe('fallback-ok');
      expect(fallback).toHaveBeenCalledTimes(2);
    });

    it('gives the fallback provider its full retries after the primary exhausts the same fingerprint', async () => {
      const scope = createRetryFingerprintScope();
      const maxRetries = 2;
      const primary = vi.fn().mockRejectedValue(connectionReset());
      await expect(withTransientRetry(primary, {
        providerName: 'primary',
        model: 'primary-model',
        maxRetries,
        baseDelay: 1,
        fingerprintScope: scope,
      })).rejects.toThrow('Connection error: ECONNRESET');
      expect(primary).toHaveBeenCalledTimes(maxRetries + 1);

      const fallback = vi.fn()
        .mockRejectedValueOnce(connectionReset())
        .mockRejectedValueOnce(connectionReset())
        .mockResolvedValue('fallback-ok');
      await expect(withTransientRetry(fallback, {
        providerName: 'fallback',
        model: 'fallback-model',
        maxRetries,
        baseDelay: 1,
        fingerprintScope: scope,
      })).resolves.toBe('fallback-ok');
      expect(fallback).toHaveBeenCalledTimes(maxRetries + 1);
    });

    it('gives the same provider a full retry budget after an earlier call exhausts retries', async () => {
      const scope = createRetryFingerprintScope();
      const maxRetries = 2;
      const shared = {
        providerName: 'same-provider',
        model: 'same-model',
        maxRetries,
        baseDelay: 1,
        fingerprintScope: scope,
      };
      const first = vi.fn().mockRejectedValue(connectionReset());
      await expect(withTransientRetry(first, shared)).rejects.toThrow('Connection error: ECONNRESET');
      expect(first).toHaveBeenCalledTimes(maxRetries + 1);

      const second = vi.fn()
        .mockRejectedValueOnce(connectionReset())
        .mockRejectedValueOnce(connectionReset())
        .mockResolvedValue('second-ok');
      await expect(withTransientRetry(second, shared)).resolves.toBe('second-ok');
      expect(second).toHaveBeenCalledTimes(maxRetries + 1);
    });

    it('does not let a different provider inherit a partial streak left by an empty success', async () => {
      const scope = createRetryFingerprintScope();
      const primary = vi.fn()
        .mockRejectedValueOnce(connectionReset())
        .mockRejectedValueOnce(connectionReset())
        .mockResolvedValue({ content: '   ', toolCalls: [] });
      await expect(withTransientRetry(primary, {
        providerName: 'primary',
        model: 'primary-model',
        maxRetries: 4,
        baseDelay: 1,
        fingerprintScope: scope,
      })).resolves.toEqual({ content: '   ', toolCalls: [] });

      const fallback = vi.fn()
        .mockRejectedValueOnce(connectionReset())
        .mockRejectedValueOnce(connectionReset())
        .mockResolvedValue('fallback-ok');
      await expect(withTransientRetry(fallback, {
        providerName: 'fallback',
        model: 'fallback-model',
        maxRetries: 4,
        baseDelay: 1,
        fingerprintScope: scope,
      })).resolves.toBe('fallback-ok');
      expect(fallback).toHaveBeenCalledTimes(3);
    });

    it('stops an identical timeout fingerprint at the threshold while the retry budget remains', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('timeout of 300000ms exceeded'));
      await expect(withTransientRetry(fn, {
        providerName: 'fingerprint-timeout',
        maxRetries: 4,
        baseDelay: 1,
      })).rejects.toMatchObject({
        name: 'RepeatedRetryableFingerprintError',
        streak: 3,
      });
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });
});
