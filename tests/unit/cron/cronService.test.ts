import { afterEach, describe, expect, it, vi } from 'vitest';

const dbState = vi.hoisted(() => ({
  cronRows: [] as unknown[],
  savedRows: [] as unknown[][],
}));

vi.mock('../../../src/main/services/core/databaseService', () => ({
  getDatabase: () => ({
    getDb: () => ({
      prepare: (sql: string) => ({
        all: () => (sql.includes('FROM cron_jobs') ? dbState.cronRows : []),
        run: (...args: unknown[]) => {
          dbState.savedRows.push(args);
        },
      }),
    }),
  }),
}));

import { CronService } from '../../../src/main/cron/cronService';

const NOW = Date.UTC(2026, 5, 12, 9, 0, 0);

function shellJob(unit: 'seconds' | 'minutes' | 'hours' | 'days' | 'weeks') {
  return {
    name: `Every 3 ${unit}`,
    scheduleType: 'every' as const,
    schedule: { type: 'every' as const, interval: 3, unit },
    action: { type: 'shell' as const, command: 'echo ok' },
    enabled: true,
  };
}

afterEach(() => {
  dbState.cronRows = [];
  dbState.savedRows = [];
});

describe('CronService every schedule units', () => {
  it('rejects weeks at runtime instead of misreading it as day-of-week cron syntax', async () => {
    const service = new CronService();

    await expect(service.createJob(shellJob('weeks'))).rejects.toThrow(/weeks|week|不支持/);

    expect(service.listJobs()).toHaveLength(0);
    expect(dbState.savedRows).toHaveLength(0);
  });

  it('schema normalization skips persisted weeks jobs', async () => {
    dbState.cronRows = [
      {
        id: 'job-weeks',
        name: 'Bad weeks job',
        description: null,
        schedule_type: 'every',
        schedule: JSON.stringify({ type: 'every', interval: 3, unit: 'weeks' }),
        action: JSON.stringify({ type: 'shell', command: 'echo ok' }),
        enabled: 1,
        max_retries: 0,
        retry_delay: 5000,
        timeout: 60000,
        tags: null,
        metadata: '{}',
        created_at: NOW,
        updated_at: NOW,
      },
    ];
    const service = new CronService();

    await service.initialize();

    expect(service.listJobs()).toHaveLength(0);
  });

  it('keeps days schedules working for dream/distill style jobs', async () => {
    const service = new CronService();

    const job = await service.createJob(shellJob('days'));

    expect(job.schedule).toMatchObject({ type: 'every', interval: 3, unit: 'days' });
    expect(service.listJobs()).toHaveLength(1);
    await service.shutdown();
  });
});
