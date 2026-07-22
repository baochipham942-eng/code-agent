import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSubagentCancellationLifecycle } from '../../../src/host/agent/subagentExecutorCancellation';

const TEST_TIMEOUT_MS = 900_000;

function createLifecycle() {
  return createSubagentCancellationLifecycle({
    agentName: 'Idle inflight test agent',
    timeoutMs: TEST_TIMEOUT_MS,
  });
}

describe('subagent idle watchdog while a model request is in flight', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts after 130s without progress when no request is in flight', () => {
    vi.useFakeTimers();
    const lifecycle = createLifecycle();

    vi.advanceTimersByTime(130_000);

    expect(lifecycle.effectiveSignal.aborted).toBe(true);
    expect(lifecycle.effectiveSignal.reason).toBe('idle-timeout');
    lifecycle.cleanupTimer();
    lifecycle.stopIdleWatchdog();
  });

  it('does not abort while a model request remains in flight for 300s', () => {
    vi.useFakeTimers();
    const lifecycle = createLifecycle();
    lifecycle.markRequestStart();

    vi.advanceTimersByTime(300_000);

    expect(lifecycle.effectiveSignal.aborted).toBe(false);
    lifecycle.cleanupTimer();
    lifecycle.stopIdleWatchdog();
  });

  it('resumes idle detection after the in-flight request ends', () => {
    vi.useFakeTimers();
    const lifecycle = createLifecycle();
    lifecycle.markRequestStart();
    vi.advanceTimersByTime(300_000);
    lifecycle.markRequestEnd();

    vi.advanceTimersByTime(130_000);

    expect(lifecycle.effectiveSignal.aborted).toBe(true);
    expect(lifecycle.effectiveSignal.reason).toBe('idle-timeout');
    lifecycle.cleanupTimer();
    lifecycle.stopIdleWatchdog();
  });

  it('still aborts at the total execution budget while a request is in flight', () => {
    vi.useFakeTimers();
    const lifecycle = createLifecycle();
    lifecycle.markRequestStart();

    vi.advanceTimersByTime(TEST_TIMEOUT_MS);

    expect(lifecycle.effectiveSignal.aborted).toBe(true);
    expect(lifecycle.effectiveSignal.reason).toBe('timeout');
    lifecycle.cleanupTimer();
    lifecycle.stopIdleWatchdog();
  });
});
