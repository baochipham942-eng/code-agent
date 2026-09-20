import { describe, expect, it } from 'vitest';

import {
  CircuitBreaker,
  isDurableCursorFenceError,
} from '../../../src/host/agent/toolExecution/circuitBreaker';

describe('CircuitBreaker durable fence', () => {
  it('recognises stale-cursor fences', () => {
    expect(isDurableCursorFenceError('Checkpoint fenced by stale cursor')).toBe(true);
    expect(isDurableCursorFenceError(new Error('Terminal write fenced by stale cursor'))).toBe(true);
    expect(isDurableCursorFenceError('File not found')).toBe(false);
  });

  it('does not trip after five consecutive cursor fences', () => {
    const breaker = new CircuitBreaker({ maxConsecutiveFailures: 5 });
    for (let index = 0; index < 5; index += 1) {
      expect(breaker.recordFailure('Checkpoint fenced by stale cursor')).toBe(false);
    }
    expect(breaker.isTripped()).toBe(false);
    expect(breaker.getFailureCount()).toBe(0);
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
