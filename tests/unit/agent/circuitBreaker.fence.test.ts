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

  it('still trips after five ordinary tool failures', () => {
    const breaker = new CircuitBreaker({ maxConsecutiveFailures: 5 });
    for (let index = 0; index < 4; index += 1) {
      expect(breaker.recordFailure('File not found')).toBe(false);
    }
    expect(breaker.recordFailure('File not found')).toBe(true);
    expect(breaker.isTripped()).toBe(true);
  });
});
