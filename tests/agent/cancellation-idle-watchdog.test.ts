// ============================================================================
// Idle-progress watchdog — AC-D
// ============================================================================
//
// AC-D: when a subagent's modelRouter.inference hangs without returning
//       any stream chunk, an idle watchdog must fire after IDLE_TIMEOUT,
//       abort the controller with reason='idle-timeout', and downstream
//       shutdown takes over.
//
// We replicate the watchdog wiring from subagentExecutor.execute here
// against fake timers so we can deterministically advance 120s+ without
// running real network calls.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CANCELLATION_TIMEOUTS } from '../../src/shared/constants';

describe('Idle-progress watchdog — AC-D', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Mirrors subagentExecutor.execute's watchdog wiring. Keep this in sync
   * with src/host/agent/subagentExecutor.ts when the implementation changes.
   */
  function startWatchdog(controller: AbortController) {
    let lastProgressAt = Date.now();
    const markProgress = () => { lastProgressAt = Date.now(); };
    const idleWatchdog = setInterval(() => {
      if (controller.signal.aborted) return;
      const idle = Date.now() - lastProgressAt;
      if (idle > CANCELLATION_TIMEOUTS.IDLE_TIMEOUT) {
        controller.abort('idle-timeout');
      }
    }, CANCELLATION_TIMEOUTS.IDLE_CHECK_INTERVAL);
    return {
      markProgress,
      stop: () => clearInterval(idleWatchdog),
    };
  }

  it('fires abort with reason=idle-timeout after IDLE_TIMEOUT with no progress', () => {
    const controller = new AbortController();
    const watchdog = startWatchdog(controller);

    // Advance just under the threshold — should NOT abort
    vi.advanceTimersByTime(CANCELLATION_TIMEOUTS.IDLE_TIMEOUT - 10);
    expect(controller.signal.aborted).toBe(false);

    // Advance past the threshold and let the next interval tick fire
    vi.advanceTimersByTime(CANCELLATION_TIMEOUTS.IDLE_CHECK_INTERVAL + 20);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe('idle-timeout');

    watchdog.stop();
  });

  it('does NOT fire when markProgress is called periodically', () => {
    const controller = new AbortController();
    const watchdog = startWatchdog(controller);

    // Tick progress every 10s for 5 minutes — never go silent
    for (let elapsed = 0; elapsed < 300_000; elapsed += 10_000) {
      vi.advanceTimersByTime(10_000);
      watchdog.markProgress();
    }

    expect(controller.signal.aborted).toBe(false);
    watchdog.stop();
  });

  it('does not double-abort an already-aborted controller', () => {
    const controller = new AbortController();
    controller.abort('user-cancel'); // pre-aborted with a different reason
    const watchdog = startWatchdog(controller);

    vi.advanceTimersByTime(CANCELLATION_TIMEOUTS.IDLE_TIMEOUT * 2);

    // reason stays as user-cancel (signal.reason is sticky once aborted)
    expect(controller.signal.reason).toBe('user-cancel');
    watchdog.stop();
  });

  it('stop() cleans up the interval so no further aborts fire', () => {
    const controller = new AbortController();
    const watchdog = startWatchdog(controller);

    watchdog.stop();

    vi.advanceTimersByTime(CANCELLATION_TIMEOUTS.IDLE_TIMEOUT * 3);
    expect(controller.signal.aborted).toBe(false);
  });
});
