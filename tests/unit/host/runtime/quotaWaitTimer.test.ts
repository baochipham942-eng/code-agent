import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const warn = vi.hoisted(() => vi.fn());

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { armQuotaWaitOnPark, clearQuotaWaitTimer, registerQuotaWaitContinuer } from '../../../../src/host/runtime/quotaWaitTimer';

describe('quotaWaitTimer due-time auto-continue trace (rework r1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T08:00:00.000Z'));
    warn.mockClear();
  });

  afterEach(() => {
    registerQuotaWaitContinuer(null);
    clearQuotaWaitTimer('run-warn');
    vi.useRealTimers();
  });

  it('leaves a distinguishable warn when the due-time continue fails', async () => {
    registerQuotaWaitContinuer(async () => {
      throw new Error('No parked durable run is available for session s-warn');
    });
    armQuotaWaitOnPark({ runId: 'run-warn', sessionId: 's-warn', dueAt: Date.now() + 75_000 });
    await vi.advanceTimersByTimeAsync(75_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[QuotaWaitTimer] due-time auto-continue failed', {
      runId: 'run-warn',
      sessionId: 's-warn',
      reason: 'No parked durable run is available for session s-warn',
    });
  });

  it('stays silent when the due-time continue succeeds', async () => {
    registerQuotaWaitContinuer(async () => ({ runId: 'run-warn' }));
    armQuotaWaitOnPark({ runId: 'run-warn', sessionId: 's-warn', dueAt: Date.now() + 75_000 });
    await vi.advanceTimersByTimeAsync(75_000);
    expect(warn).not.toHaveBeenCalled();
  });
});
