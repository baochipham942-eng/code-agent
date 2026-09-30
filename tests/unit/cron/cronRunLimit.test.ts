import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CronJobExecution } from '../../../src/shared/contract/cron';

const automationState = vi.hoisted(() => ({
  recordCreated: vi.fn(async () => undefined),
  recordEvent: vi.fn(async () => undefined),
  getBySourceRef: vi.fn(() => null),
  upsert: vi.fn(() => undefined),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getDb: () => ({
      prepare: () => ({
        all: () => [],
        get: () => undefined,
        run: () => ({ changes: 0 }),
      }),
    }),
  }),
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    onSettingsUpdated: vi.fn(),
    getSettings: () => ({ ui: { language: 'zh' } }),
  }),
}));

vi.mock('../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => automationState,
}));

import { applyRunToLimit } from '../../../src/host/cron/cronRunLimit';
import { assertExecutionLocationConstraints } from '../../../src/host/cron/cronExecutionPolicy';
import { CronService } from '../../../src/host/cron/cronService';

type SettleExecution = Pick<CronJobExecution, 'status' | 'retryAttempt'>;

function execution(status: CronJobExecution['status'], retryAttempt = 0): SettleExecution {
  return { status, retryAttempt };
}

describe('applyRunToLimit count rules', () => {
  const base = { scheduleType: 'every' as const, runsOn: 'local' as const, maxRuns: 2, runCount: 0 };

  it('counts completed and failed first attempts', () => {
    expect(applyRunToLimit(base, execution('completed'))).toEqual({ runCount: 1, limitReached: false });
    expect(applyRunToLimit(base, execution('failed'))).toEqual({ runCount: 1, limitReached: false });
  });

  it('does not count retries or cancelled/capacity-wait runs', () => {
    expect(applyRunToLimit(base, execution('completed', 1))).toEqual({ runCount: 0, limitReached: false });
    expect(applyRunToLimit(base, execution('failed', 2))).toEqual({ runCount: 0, limitReached: false });
    expect(applyRunToLimit(base, execution('cancelled'))).toEqual({ runCount: 0, limitReached: false });
    expect(applyRunToLimit(base, execution('interrupted'))).toEqual({ runCount: 0, limitReached: false });
  });

  it('skips one-time (at) jobs and cloud jobs', () => {
    expect(applyRunToLimit({ ...base, scheduleType: 'at' as const }, execution('completed')))
      .toEqual({ runCount: 0, limitReached: false });
    expect(applyRunToLimit({ ...base, runsOn: 'cloud' as const, maxRuns: undefined }, execution('completed')))
      .toEqual({ runCount: 0, limitReached: false });
  });

  it('reaches the limit at exactly N', () => {
    const afterFirst = applyRunToLimit(base, execution('completed'));
    expect(afterFirst.limitReached).toBe(false);
    const afterSecond = applyRunToLimit({ ...base, runCount: afterFirst.runCount }, execution('completed'));
    expect(afterSecond).toEqual({ runCount: 2, limitReached: true });
  });

  it('counts unbounded runs without ever reaching a limit', () => {
    const outcome = applyRunToLimit({ ...base, maxRuns: undefined, runCount: 41 }, execution('completed'));
    expect(outcome).toEqual({ runCount: 42, limitReached: false });
  });
});

describe('maxRuns validation', () => {
  const schedule = { type: 'every' as const, interval: 5, unit: 'minutes' as const };

  it.each([0, 1.5, -3])('rejects maxRuns %p on local jobs', (maxRuns) => {
    expect(() => assertExecutionLocationConstraints({ runsOn: 'local', schedule, maxRuns }))
      .toThrow('maxRuns must be an integer greater than or equal to 1.');
  });

  it('rejects maxRuns on cloud jobs even when the value is valid', () => {
    expect(() => assertExecutionLocationConstraints({ runsOn: 'cloud', schedule: { ...schedule, interval: 2, unit: 'hours' as const }, maxRuns: 3 }))
      .toThrow('maxRuns is only supported for local jobs');
  });

  it('accepts an integer >= 1 on local jobs and an unset maxRuns', () => {
    expect(() => assertExecutionLocationConstraints({ runsOn: 'local', schedule, maxRuns: 1 })).not.toThrow();
    expect(() => assertExecutionLocationConstraints({ runsOn: 'local', schedule })).not.toThrow();
  });
});

describe('re-enable resets the run counter', () => {
  afterEach(() => {
    automationState.recordCreated.mockClear();
    automationState.recordEvent.mockClear();
    automationState.getBySourceRef.mockClear();
    automationState.upsert.mockClear();
  });

  async function createDisabledLimitedJob() {
    const service = new CronService();
    const job = await service.createJob({
      name: 'Limited job',
      scheduleType: 'every',
      schedule: { type: 'every', interval: 5, unit: 'minutes' },
      action: { type: 'shell', command: 'echo ok' },
      enabled: false,
      maxRuns: 2,
    });
    return { service, job };
  }

  it('resets runCount and drops metadata.disabledReason when re-enabling a disabled job', async () => {
    const { service, job } = await createDisabledLimitedJob();
    await service.updateJob(job.id, { runCount: 2, metadata: { disabledReason: 'max_runs_reached' } });

    const reenabled = await service.updateJob(job.id, { enabled: true });

    expect(reenabled?.runCount).toBe(0);
    expect(reenabled?.metadata).toEqual({});
    await service.shutdown();
  });

  it('does not reset the counter on a maxRuns-only edit', async () => {
    const { service, job } = await createDisabledLimitedJob();
    await service.updateJob(job.id, { runCount: 1 });

    const edited = await service.updateJob(job.id, { maxRuns: 5 });

    expect(edited?.runCount).toBe(1);
    expect(edited?.maxRuns).toBe(5);
    await service.shutdown();
  });
});
