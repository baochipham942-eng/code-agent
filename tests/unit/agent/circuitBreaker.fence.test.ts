import { describe, expect, it } from 'vitest';

import { CircuitBreaker } from '../../../src/host/agent/toolExecution/circuitBreaker';

describe('CircuitBreaker durable fence', () => {
  it('counts durable cursor fences toward the trip threshold', () => {
    const breaker = new CircuitBreaker({ maxConsecutiveFailures: 5 });
    for (let index = 0; index < 4; index += 1) {
      expect(breaker.recordFailure('Checkpoint fenced by stale cursor')).toBe(false);
    }
    expect(breaker.recordFailure('Checkpoint fenced by stale cursor')).toBe(true);
    expect(breaker.isTripped()).toBe(true);
    expect(breaker.getFailureCount()).toBe(5);
  });

  it('still trips after five infrastructure failures', () => {
    const breaker = new CircuitBreaker({ maxConsecutiveFailures: 5 });
    for (let index = 0; index < 4; index += 1) {
      expect(breaker.recordFailure('Failed to fetch URL: fetch failed')).toBe(false);
    }
    expect(breaker.recordFailure('Failed to fetch URL: fetch failed')).toBe(true);
    expect(breaker.isTripped()).toBe(true);
  });

  it('never trips on business-expected failures like missing files', () => {
    const breaker = new CircuitBreaker({ maxConsecutiveFailures: 5 });
    for (let index = 0; index < 8; index += 1) {
      expect(breaker.recordFailure('File not found')).toBe(false);
    }
    expect(breaker.isTripped()).toBe(false);
    expect(breaker.getFailureCount()).toBe(0);
  });
});
