import { describe, expect, it } from 'vitest';
import { getSearchErrorCircuitBreakerCooldown } from '../../../../src/main/tools/web/search';

describe('search error circuit breaker classification', () => {
  it('treats provider quota exhaustion as a long cooldown', () => {
    const cooldown = getSearchErrorCircuitBreakerCooldown(
      'HTTP 401: {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota"}}',
    );

    expect(cooldown).toBeGreaterThanOrEqual(23 * 60 * 60 * 1000);
  });

  it('treats a bare 401 (rejected / expired key) as a long cooldown', () => {
    const cooldown = getSearchErrorCircuitBreakerCooldown('HTTP 401: Unauthorized');
    expect(cooldown).toBeGreaterThanOrEqual(23 * 60 * 60 * 1000);
  });

  it("treats Tavily's 432 plan-limit code as a long cooldown", () => {
    const cooldown = getSearchErrorCircuitBreakerCooldown('HTTP 432: plan usage limit exceeded');
    expect(cooldown).toBeGreaterThanOrEqual(23 * 60 * 60 * 1000);
  });

  it('treats 429 rate limit as a short cooldown', () => {
    const cooldown = getSearchErrorCircuitBreakerCooldown('HTTP 429: Too Many Requests');

    expect(cooldown).toBeGreaterThanOrEqual(9 * 60 * 1000);
    expect(cooldown).toBeLessThan(60 * 60 * 1000);
  });

  it('does not circuit-break ordinary failures', () => {
    expect(getSearchErrorCircuitBreakerCooldown('HTTP 500: upstream exploded')).toBeNull();
  });
});
