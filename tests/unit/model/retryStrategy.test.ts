// ============================================================================
// Retry Strategy Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  extractRetryAfterMs,
  isFallbackEligible,
  isTransientError,
  withTransientRetry,
} from '../../../src/main/model/providers/retryStrategy';

// Mock logger to suppress console output during tests
vi.mock('../../../src/main/model/providers/shared', () => ({
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

      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValue('success');

      await expect(
        withTransientRetry(fn, {
          providerName: 'test',
          maxRetries: 2,
          baseDelay: 1,
          signal: controller.signal,
        })
      ).rejects.toThrow('ECONNRESET');

      expect(fn).toHaveBeenCalledTimes(1);
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

    it('uses exponential backoff (baseDelay * 2^attempt)', async () => {
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
      expect(delays).toEqual([4, 8]);
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
});
