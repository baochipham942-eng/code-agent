import { describe, expect, it } from 'vitest';
import {
  isObservedCacheHit,
  noteStagnationFingerprint,
  recordSessionCacheHit,
} from '../../../src/host/model/cacheHitObservation';

describe('cache hit effective / idle split', () => {
  it('does not treat cacheRead>0 as the only hit, and an unchanged fingerprint is idle', () => {
    expect(isObservedCacheHit({ cacheReadTokens: 0 })).toBe(false);
    expect(isObservedCacheHit({ cacheReadTokens: 0, inferenceCacheHit: true })).toBe(true);
    expect(isObservedCacheHit({ cacheReadTokens: 0, toolCacheHit: true })).toBe(true);
    expect(isObservedCacheHit({ cacheReadTokens: 12 })).toBe(true);

    const untouched = `hit-untouched-${Date.now()}`;
    expect(recordSessionCacheHit(untouched).kind).toBe('idle');
    const repeated = `hit-repeated-${Date.now()}`;
    recordSessionCacheHit(repeated, 'fp-a');
    expect(recordSessionCacheHit(repeated, 'fp-a').kind).toBe('idle');
    expect(recordSessionCacheHit(repeated, 'fp-b').kind).toBe('effective');
  });

  it('counts a tool-cache replay with the same fingerprint as idle and reads hitRate', () => {
    const sessionId = `hit-${Date.now()}-same`;
    noteStagnationFingerprint(sessionId, 'fp-same');
    const first = recordSessionCacheHit(sessionId, 'fp-same');
    const second = recordSessionCacheHit(sessionId, 'fp-same');

    expect(first.kind).toBe('effective');
    expect(second.kind).toBe('idle');
    expect(second.effective).toBe(1);
    expect(second.idle).toBe(1);
    expect(second.inferenceHitRate).toMatch(/%$/);
  });

  it('counts a later hit as effective after the stagnation fingerprint changes', () => {
    const sessionId = `hit-${Date.now()}-change`;
    const first = recordSessionCacheHit(sessionId, 'fp-1');
    noteStagnationFingerprint(sessionId, 'fp-2');
    const second = recordSessionCacheHit(sessionId);

    expect(first.kind).toBe('effective');
    expect(second.kind).toBe('effective');
    expect(second.effective).toBe(2);
    expect(second.idle).toBe(0);
  });
});
