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

vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyTaskComplete: vi.fn() },
}));

import { settleCronRunLimit, type CronRunLimitHooks } from '../../../src/host/cron/cronRunLimit';
import { assertExecutionLocationConstraints } from '../../../src/host/cron/cronExecutionPolicy';
import { CronService } from '../../../src/host/cron/cronService';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';

interface SettleHarness {
  hooks: CronRunLimitHooks;
  state: { definition: CronJobDefinition | undefined };
  updates: Array<Partial<Omit<CronJobDefinition, 'id' | 'createdAt'>>>;
}

function makeSettleHarness(definition: Partial<CronJobDefinition> = {}): SettleHarness {
  const state: SettleHarness['state'] = {
    definition: {
      id: 'job-1',
      name: 'Limited job',
      scheduleType: 'every',
      schedule: { type: 'every', interval: 5, unit: 'minutes' },
      action: { type: 'shell', command: 'echo ok' },
      runsOn: 'local',
      enabled: true,
      maxRuns: 2,
      runCount: 0,
      createdAt: 1,
      updatedAt: 1,
      ...definition,
    },
  };
  const updates: SettleHarness['updates'] = [];
  return {
    state,
    updates,
    hooks: {
      getDefinition: () => state.definition,
      updateJob: async (_jobId, next) => {
        if (state.definition) state.definition = { ...state.definition, ...next };
        updates.push(next);
        return state.definition ?? null;
      },
    },
  };
}

const fullExecution = (status: CronJobExecution['status'], retryAttempt = 0): CronJobExecution => ({
  id: 'execution-1',
  jobId: 'job-1',
  status,
  scheduledAt: 1,
  retryAttempt,
});

describe('settleCronRunLimit count rules', () => {
  afterEach(() => {
    automationState.recordEvent.mockClear();
  });

  it('counts completed and failed first attempts', async () => {
    const completed = makeSettleHarness();
    expect(await settleCronRunLimit('job-1', fullExecution('completed'), false, completed.hooks)).toBe(false);
    expect(completed.updates).toEqual([{ runCount: 1 }]);

    const failed = makeSettleHarness();
    expect(await settleCronRunLimit('job-1', fullExecution('failed'), false, failed.hooks)).toBe(false);
    expect(failed.updates).toEqual([{ runCount: 1 }]);
  });

  it('does not count retries or cancelled/capacity-wait runs', async () => {
    for (const settle of [
      fullExecution('completed', 1),
      fullExecution('failed', 2),
      fullExecution('cancelled'),
      fullExecution('interrupted'),
    ]) {
      const harness = makeSettleHarness();
      expect(await settleCronRunLimit('job-1', settle, false, harness.hooks)).toBe(false);
      expect(harness.updates).toEqual([]);
    }
  });

  it('skips one-time (at) jobs and cloud jobs', async () => {
    const atJob = makeSettleHarness({ scheduleType: 'at', schedule: { type: 'at', datetime: 2 } });
    expect(await settleCronRunLimit('job-1', fullExecution('completed'), false, atJob.hooks)).toBe(false);
    expect(atJob.updates).toEqual([]);

    const cloudJob = makeSettleHarness({ runsOn: 'cloud', maxRuns: undefined });
    expect(await settleCronRunLimit('job-1', fullExecution('completed'), false, cloudJob.hooks)).toBe(false);
    expect(cloudJob.updates).toEqual([]);
  });

  it('reaches the limit at exactly N: disables with max_runs_reached and posts one inbox event', async () => {
    const harness = makeSettleHarness({ runCount: 1 });
    expect(await settleCronRunLimit('job-1', fullExecution('completed'), false, harness.hooks)).toBe(true);
    expect(harness.updates).toEqual([
      { runCount: 2 },
      { enabled: false, metadata: { disabledReason: 'max_runs_reached' } },
    ]);
    expect(automationState.recordEvent).toHaveBeenCalledTimes(1);
    expect(automationState.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'completed',
      recordStatus: 'paused',
      eventId: 'max_runs:job-1',
    }));
  });

  it('does not double-disable when the same run already disabled the job (permanent path)', async () => {
    const harness = makeSettleHarness({ runCount: 1 });
    expect(await settleCronRunLimit('job-1', fullExecution('failed'), true, harness.hooks)).toBe(true);
    expect(harness.updates).toEqual([{ runCount: 2 }]);
    expect(automationState.recordEvent).not.toHaveBeenCalled();
  });

  it('does not disable a job that is already disabled', async () => {
    const harness = makeSettleHarness({ runCount: 1, enabled: false });
    expect(await settleCronRunLimit('job-1', fullExecution('completed'), false, harness.hooks)).toBe(false);
    expect(harness.updates).toEqual([{ runCount: 2 }]);
    expect(automationState.recordEvent).not.toHaveBeenCalled();
  });

  it('counts unbounded runs without ever reaching a limit', async () => {
    const harness = makeSettleHarness({ maxRuns: undefined, runCount: 41 });
    expect(await settleCronRunLimit('job-1', fullExecution('completed'), false, harness.hooks)).toBe(false);
    expect(harness.updates).toEqual([{ runCount: 42 }]);
  });

  it('is a no-op when the job is gone', async () => {
    const harness = makeSettleHarness();
    harness.state.definition = undefined;
    expect(await settleCronRunLimit('job-1', fullExecution('completed'), false, harness.hooks)).toBe(false);
    expect(harness.updates).toEqual([]);
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
