// ============================================================================
// spawnAgent single-spawn AbortSignal bridge — AC-A core fix
// ============================================================================
//
// The bug we fixed: spawnAgent.ts single-spawn path created
// `const abortController = new AbortController()` but never listened to
// `context.abortSignal`. Result: parent ESC did not stop the child.
//
// This test reproduces the bridge logic in isolation (the same pattern
// we put inline in spawnAgent.ts) and verifies:
// 1. Parent abort → child abort within microtask (AC-A 1s budget trivially)
// 2. Pre-aborted parent → child aborted on construction
// 3. Reason transparently propagates ('user-cancel' / 'parent-cancel'
//    / 'session-switch')
// 4. Bridge does not reverse (child abort first → parent unchanged)
// ============================================================================

import { describe, it, expect } from 'vitest';

/**
 * Mirrors the bridge wiring inserted in
 * `src/main/agent/multiagentTools/spawnAgent.ts` right after
 * `const abortController = new AbortController()`. Keep in sync.
 */
function bridgeParentToChild(
  parentSignal: AbortSignal | undefined,
  child: AbortController,
): void {
  if (!parentSignal) return;
  if (parentSignal.aborted) {
    child.abort(parentSignal.reason ?? 'parent-cancel');
    return;
  }
  parentSignal.addEventListener(
    'abort',
    () => {
      if (!child.signal.aborted) {
        child.abort(parentSignal.reason ?? 'parent-cancel');
      }
    },
    { once: true },
  );
}

describe('spawnAgent parent→child abortSignal bridge — AC-A', () => {
  it('parent abort with reason propagates to child', () => {
    const parent = new AbortController();
    const child = new AbortController();
    bridgeParentToChild(parent.signal, child);

    parent.abort('user-cancel');

    expect(child.signal.aborted).toBe(true);
    expect(child.signal.reason).toBe('user-cancel');
  });

  it('already-aborted parent propagates immediately', () => {
    const parent = new AbortController();
    parent.abort('session-switch');
    const child = new AbortController();
    bridgeParentToChild(parent.signal, child);

    expect(child.signal.aborted).toBe(true);
    expect(child.signal.reason).toBe('session-switch');
  });

  it('parent abort without reason still propagates aborted state', () => {
    // Note: Node fills parentSignal.reason with a DOMException when abort()
    // is called without args, so the bridge passes that through. The bridge's
    // 'parent-cancel' fallback only triggers when reason is literally
    // null/undefined (very rare — modern abort() always synthesizes a reason).
    const parent = new AbortController();
    const child = new AbortController();
    bridgeParentToChild(parent.signal, child);

    parent.abort();

    expect(child.signal.aborted).toBe(true);
    // reason is whatever Node attached (DOMException or string)
    expect(child.signal.reason).toBe(parent.signal.reason);
  });

  it('AC-F symmetry: child abort first does NOT abort parent', () => {
    const parent = new AbortController();
    const child = new AbortController();
    bridgeParentToChild(parent.signal, child);

    child.abort('child-error');

    expect(child.signal.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
  });

  it('AC-E: missing parent signal is a no-op (legacy callers unaffected)', () => {
    const child = new AbortController();
    expect(() => bridgeParentToChild(undefined, child)).not.toThrow();
    expect(child.signal.aborted).toBe(false);
  });

  it('parent abort propagation latency is synchronous (well under 1s budget)', () => {
    const parent = new AbortController();
    const child = new AbortController();
    bridgeParentToChild(parent.signal, child);

    const start = Date.now();
    parent.abort('user-cancel');
    const latency = Date.now() - start;

    expect(child.signal.aborted).toBe(true);
    expect(latency).toBeLessThan(50);  // well under the 1s AC-A target
  });
});
