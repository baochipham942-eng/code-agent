// ============================================================================
// Retry Strategy Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isTransientError, withTransientRetry } from '../../../src/main/model/providers/retryStrategy';

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

      it('should detect network socket disconnected', () => {
        expect(isTransientError('network socket disconnected')).toBe(true);
      });

      it('should detect empty stream response', () => {
        expect(isTransientError('流式响应无内容')).toBe(true);
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

      it('should not match 400 errors', () => {
        expect(isTransientError('400 Bad Request')).toBe(false);
      });

      it('should not match unknown codes', () => {
        expect(isTransientError('error', 'ERR_INVALID_ARG_TYPE')).toBe(false);
      });

      it('should handle no code', () => {
        expect(isTransientError('some error')).toBe(false);
      });
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
  });
});
