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
  routeFailureCode,
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
      'depth-limit',
      'child-refusal',
      'child-max-tokens',
      'parent-gone',
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

// ============================================================================
// 结构化失败码（swarm 护栏 P1-2 #1）—— depth-limit / child-refusal / child-max-tokens
// ============================================================================
describe('structured failure codes', () => {
  const STRUCTURED: CancellationReason[] = [
    'depth-limit',
    'child-refusal',
    'child-max-tokens',
  ];

  it('the 3 structured codes are NON_CASCADE (single-agent, must not abort siblings)', () => {
    const nonCascade = new Set<string>(NON_CASCADE_REASONS);
    for (const code of STRUCTURED) {
      expect(nonCascade.has(code)).toBe(true);
      // 关键不变量：细粒度 child 失败码不能 cascade 到兄弟
      expect(isCascadeReason(code)).toBe(false);
    }
  });

  it('the 3 structured codes are recognized as known reasons', () => {
    for (const code of STRUCTURED) {
      expect(isKnownCancellationReason(code)).toBe(true);
      // normalize 应原样透传，不再 fallback 到 user-cancel
      expect(normalizeCancellationReason(code)).toBe(code);
    }
  });
});

// ============================================================================
// 孤儿回收（swarm 护栏 P1-2 #5）—— parent-gone
// ============================================================================
describe('orphan reclamation — parent-gone', () => {
  it('parent-gone 是已知 NON_CASCADE 失败码', () => {
    expect(isKnownCancellationReason('parent-gone')).toBe(true);
    expect(new Set<string>(NON_CASCADE_REASONS).has('parent-gone')).toBe(true);
    // 孤儿自我中止只影响自己；它的子孙通过现有 parent-cancel 桥接级联，不靠本码
    expect(isCascadeReason('parent-gone')).toBe(false);
    expect(normalizeCancellationReason('parent-gone')).toBe('parent-gone');
  });

  it('parent-gone → throw（父已消失，确定性终态，重试无意义）', () => {
    expect(routeFailureCode('parent-gone')).toBe('throw');
  });
});

describe('routeFailureCode — 按码分治消费策略', () => {
  it('depth-limit → throw（确定性失败，重试无意义）', () => {
    expect(routeFailureCode('depth-limit')).toBe('throw');
  });

  it('child-refusal → surface（上抛给编排层，不自动重试）', () => {
    expect(routeFailureCode('child-refusal')).toBe('surface');
  });

  it('child-max-tokens → degrade（子已产出部分工作，可降级/截断续跑）', () => {
    expect(routeFailureCode('child-max-tokens')).toBe('degrade');
  });

  it('transient codes（timeout / idle-timeout / child-error）→ retry', () => {
    expect(routeFailureCode('timeout')).toBe('retry');
    expect(routeFailureCode('idle-timeout')).toBe('retry');
    expect(routeFailureCode('child-error')).toBe('retry');
  });

  it('terminal codes（budget-exceeded / user-cancel / session-switch / parent-cancel）→ throw', () => {
    expect(routeFailureCode('budget-exceeded')).toBe('throw');
    expect(routeFailureCode('user-cancel')).toBe('throw');
    expect(routeFailureCode('session-switch')).toBe('throw');
    expect(routeFailureCode('parent-cancel')).toBe('throw');
  });

  it('unknown / undefined → surface（安全默认：交编排层决策，不静默重试）', () => {
    expect(routeFailureCode('bogus')).toBe('surface');
    expect(routeFailureCode(undefined)).toBe('surface');
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
