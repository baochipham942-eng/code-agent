// ============================================================================
// Cancellation Contract — unit tests for partition + normalization
// ============================================================================
//
// Covers AC-F (cascading 不反向 unit-level) by testing
// createChildAbortController + cancellation reason partitions.
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  CASCADE_REASONS,
  NON_CASCADE_REASONS,
  isCascadeReason,
  isKnownCancellationReason,
  normalizeCancellationReason,
  type CancellationReason,
} from '../../src/shared/contract/cancellation';
import { createChildAbortController } from '../../src/main/agent/shutdownProtocol';

describe('CancellationReason partition', () => {
  it('CASCADE_REASONS and NON_CASCADE_REASONS are mutually exclusive', () => {
    const cascade = new Set<string>(CASCADE_REASONS);
    const nonCascade = new Set<string>(NON_CASCADE_REASONS);
    for (const r of cascade) {
      expect(nonCascade.has(r)).toBe(false);
    }
  });

  it('every known reason is in exactly one partition', () => {
    const all = new Set<string>([...CASCADE_REASONS, ...NON_CASCADE_REASONS]);
    const expected: CancellationReason[] = [
      'user-cancel',
      'session-switch',
      'parent-cancel',
      'child-error',
      'timeout',
      'idle-timeout',
      'budget-exceeded',
    ];
    for (const r of expected) {
      expect(all.has(r)).toBe(true);
    }
    expect(all.size).toBe(expected.length);
  });

  it('isCascadeReason: cascade reasons return true', () => {
    for (const r of CASCADE_REASONS) {
      expect(isCascadeReason(r)).toBe(true);
    }
  });

  it('isCascadeReason: non-cascade reasons return false', () => {
    for (const r of NON_CASCADE_REASONS) {
      expect(isCascadeReason(r)).toBe(false);
    }
  });

  it('isCascadeReason: unknown values return false', () => {
    expect(isCascadeReason('bogus')).toBe(false);
    expect(isCascadeReason(undefined)).toBe(false);
    expect(isCascadeReason(null)).toBe(false);
    expect(isCascadeReason(42)).toBe(false);
  });

  it('isKnownCancellationReason: covers both partitions', () => {
    expect(isKnownCancellationReason('user-cancel')).toBe(true);
    expect(isKnownCancellationReason('child-error')).toBe(true);
    expect(isKnownCancellationReason('idle-timeout')).toBe(true);
    expect(isKnownCancellationReason('bogus')).toBe(false);
  });

  it('normalizeCancellationReason: passes through known reasons', () => {
    expect(normalizeCancellationReason('user-cancel')).toBe('user-cancel');
    expect(normalizeCancellationReason('idle-timeout')).toBe('idle-timeout');
  });

  it('normalizeCancellationReason: unknown falls back to user-cancel by default', () => {
    expect(normalizeCancellationReason('weird')).toBe('user-cancel');
    expect(normalizeCancellationReason(undefined)).toBe('user-cancel');
  });

  it('normalizeCancellationReason: explicit fallback wins on unknown', () => {
    expect(normalizeCancellationReason('weird', 'parent-cancel')).toBe('parent-cancel');
  });
});

// AC-F — cascading isolation guarantee
describe('createChildAbortController — AC-F (cascade direction)', () => {
  it('parent abort propagates to child with reason', () => {
    const parent = new AbortController();
    const child = createChildAbortController(parent);

    expect(parent.signal.aborted).toBe(false);
    expect(child.signal.aborted).toBe(false);

    parent.abort('user-cancel');

    expect(parent.signal.aborted).toBe(true);
    expect(child.signal.aborted).toBe(true);
    expect(child.signal.reason).toBe('user-cancel');
  });

  it('child abort does NOT propagate to parent (AC-F)', () => {
    const parent = new AbortController();
    const child = createChildAbortController(parent);

    child.abort('child-error');

    expect(child.signal.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
  });

  it('already-aborted parent propagates immediately to new child', () => {
    const parent = new AbortController();
    parent.abort('parent-cancel');

    const child = createChildAbortController(parent);

    expect(child.signal.aborted).toBe(true);
    expect(child.signal.reason).toBe('parent-cancel');
  });
});
