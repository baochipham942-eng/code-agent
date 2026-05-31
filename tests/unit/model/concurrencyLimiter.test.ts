// ============================================================================
// ConcurrencyLimiter Tests
// ============================================================================

import { afterEach, describe, it, expect } from 'vitest';
import {
  ConcurrencyLimiter,
  getEffectiveProviderConcurrency,
  getProviderConcurrencyKey,
  getProviderLimiter,
  setProviderConcurrencyOverrides,
} from '../../../src/main/model/concurrencyLimiter';

afterEach(() => {
  setProviderConcurrencyOverrides({});
});

describe('ConcurrencyLimiter', () => {
  it('caps in-flight requests at maxConcurrent and queues the rest', async () => {
    const limiter = new ConcurrencyLimiter('test', 2, 0);

    // 抢占 2 个许可（达到上限）
    await limiter.acquire();
    await limiter.acquire();

    // 第 3 个应被排队，不立即 resolve
    let third = false;
    const p = limiter.acquire().then(() => { third = true; });
    await new Promise(r => setTimeout(r, 10));
    expect(third).toBe(false);

    // 释放一个 → 队列里的第 3 个被放行
    limiter.release();
    await p;
    expect(third).toBe(true);
  });

  it('降级后并发上限下降（onRateLimit）', async () => {
    const limiter = new ConcurrencyLimiter('test', 2, 0);
    limiter.onRateLimit(); // 2 → 1

    await limiter.acquire(); // 占满 1
    let second = false;
    const p = limiter.acquire().then(() => { second = true; });
    await new Promise(r => setTimeout(r, 10));
    expect(second).toBe(false); // 降级后上限=1，第 2 个排队

    limiter.release();
    await p;
    expect(second).toBe(true);
  });
});

describe('getProviderLimiter', () => {
  it('为声明了并发上限的 provider（zhipu）返回限流器', () => {
    expect(getProviderLimiter('zhipu')).toBeInstanceOf(ConcurrencyLimiter);
  });

  it('为声明了默认并发上限的 provider（xiaomi）返回限流器', () => {
    expect(getProviderLimiter('xiaomi')).toBeInstanceOf(ConcurrencyLimiter);
  });

  it('为未声明的 provider 返回 null', () => {
    expect(getProviderLimiter('unknown-provider')).toBeNull();
  });

  it('空 provider 返回 null', () => {
    expect(getProviderLimiter(undefined)).toBeNull();
    expect(getProviderLimiter(null)).toBeNull();
  });

  it('同一 provider 复用同一实例', () => {
    expect(getProviderLimiter('zhipu')).toBe(getProviderLimiter('zhipu'));
  });

  it('normalizes provider aliases before resolving overrides and limiter instances', () => {
    setProviderConcurrencyOverrides({
      anthropic: { maxConcurrent: 2, minIntervalMs: 0 },
    });

    expect(getProviderConcurrencyKey(' anthropic ')).toBe('claude');
    expect(getEffectiveProviderConcurrency('claude')).toBe(2);
    expect(getProviderLimiter('anthropic')).toBe(getProviderLimiter('claude'));
  });
});
