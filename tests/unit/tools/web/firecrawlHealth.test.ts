import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  recordFirecrawlOutcome,
  isFirecrawlHealthy,
  resetFirecrawlHealth,
  shouldUseFirecrawlForUrl,
  FIRECRAWL_HEALTH,
} from '../../../../src/host/tools/web/firecrawlClient';

describe('Firecrawl 健康门 (P4 失败兜底)', () => {
  beforeEach(() => {
    resetFirecrawlHealth();
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    resetFirecrawlHealth();
    vi.useRealTimers();
  });

  it('初始为健康', () => {
    expect(isFirecrawlHealthy()).toBe(true);
  });

  it('连续失败达到阈值后进入冷却（不健康）', () => {
    for (let i = 0; i < FIRECRAWL_HEALTH.FAILURE_THRESHOLD; i++) {
      expect(isFirecrawlHealthy()).toBe(true);
      recordFirecrawlOutcome(false);
    }
    expect(isFirecrawlHealthy()).toBe(false);
  });

  it('达到阈值前仍健康', () => {
    for (let i = 0; i < FIRECRAWL_HEALTH.FAILURE_THRESHOLD - 1; i++) {
      recordFirecrawlOutcome(false);
    }
    expect(isFirecrawlHealthy()).toBe(true);
  });

  it('成功会重置失败计数', () => {
    recordFirecrawlOutcome(false);
    recordFirecrawlOutcome(false);
    recordFirecrawlOutcome(true); // reset
    recordFirecrawlOutcome(false);
    expect(isFirecrawlHealthy()).toBe(true);
  });

  it('冷却期过后自动恢复健康', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T00:00:00Z'));
    for (let i = 0; i < FIRECRAWL_HEALTH.FAILURE_THRESHOLD; i++) {
      recordFirecrawlOutcome(false);
    }
    expect(isFirecrawlHealthy()).toBe(false);
    vi.setSystemTime(new Date(Date.now() + FIRECRAWL_HEALTH.COOLDOWN_MS + 1000));
    expect(isFirecrawlHealthy()).toBe(true);
  });

  it('不健康时 shouldUseFirecrawlForUrl 对正常 URL 也返回 false', () => {
    for (let i = 0; i < FIRECRAWL_HEALTH.FAILURE_THRESHOLD; i++) {
      recordFirecrawlOutcome(false);
    }
    expect(shouldUseFirecrawlForUrl('https://example.com')).toBe(false);
  });
});
