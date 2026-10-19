// ============================================================================
// CronService.onJobsChanged 单测（ADR-083 append 2026-10-18，schedule-keepalive）：
// 任务增/删/改/启停必须通知监听器——daemon 据此重算去留（删掉最后一个已启用
// 任务，纯为任务留守的 daemon 随之退出）。mock 面与 cronService.test.ts 同款
// （DB / configService / sessionAutomation 替身），只验通知合同，不验执行。
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest';

const dbState = vi.hoisted(() => ({
  cronRows: [] as unknown[],
  savedRows: [] as unknown[][],
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getDb: () => ({
      prepare: (sql: string) => ({
        all: () => (sql.includes('FROM cron_jobs') ? dbState.cronRows : []),
        get: () => undefined,
        run: (...args: unknown[]) => {
          dbState.savedRows.push(args);
          return { changes: 0 };
        },
      }),
    }),
  }),
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ onSettingsUpdated: vi.fn(), getSettings: () => ({}) }),
}));

vi.mock('../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => ({
    recordCreated: vi.fn(async () => undefined),
    recordEvent: vi.fn(async () => undefined),
    getBySourceRef: vi.fn(() => null),
    upsert: vi.fn(() => undefined),
  }),
}));

import { CronService } from '../../../src/host/cron/cronService';

function shellJob(name: string) {
  return {
    name,
    scheduleType: 'every' as const,
    schedule: { type: 'every' as const, interval: 3, unit: 'hours' as const },
    action: { type: 'shell' as const, command: 'echo ok' },
    enabled: true,
  };
}

afterEach(() => {
  dbState.cronRows = [];
  dbState.savedRows = [];
});

describe('CronService.onJobsChanged（schedule-keepalive 通知合同）', () => {
  it('createJob / updateJob / deleteJob 各通知一次；enable/disable 经 updateJob 同样通知', async () => {
    const service = new CronService();
    const listener = vi.fn();
    service.onJobsChanged(listener);

    const job = await service.createJob(shellJob('notify-on-create'));
    expect(listener).toHaveBeenCalledTimes(1);

    await service.updateJob(job.id, { name: 'notify-on-update' });
    expect(listener).toHaveBeenCalledTimes(2);

    await service.disableJob(job.id);
    expect(listener).toHaveBeenCalledTimes(3);

    await service.enableJob(job.id);
    expect(listener).toHaveBeenCalledTimes(4);

    await expect(service.deleteJob(job.id)).resolves.toBe(true);
    expect(listener).toHaveBeenCalledTimes(5);
    await service.shutdown();
  });

  it('通知时任务集合已更新（监听器里读 listJobs 拿到新口径）', async () => {
    const service = new CronService();
    const armedCounts: number[] = [];
    service.onJobsChanged(() => {
      armedCounts.push(service.listJobs({ enabled: true }).length);
    });
    const job = await service.createJob(shellJob('armed-visible-immediately'));
    await service.deleteJob(job.id);
    expect(armedCounts).toEqual([1, 0]);
    await service.shutdown();
  });

  it('取消订阅后不再通知；监听器抛错不打断后续监听器与 cron 操作', async () => {
    const service = new CronService();
    const boom = vi.fn(() => { throw new Error('listener blew up'); });
    const quiet = vi.fn();
    const unsubscribe = service.onJobsChanged(boom);
    service.onJobsChanged(quiet);

    const job = await service.createJob(shellJob('listener-isolation'));
    expect(boom).toHaveBeenCalledTimes(1);
    expect(quiet).toHaveBeenCalledTimes(1);

    unsubscribe();
    await service.updateJob(job.id, { name: 'after-unsubscribe' });
    expect(boom).toHaveBeenCalledTimes(1);
    expect(quiet).toHaveBeenCalledTimes(2);
    await service.shutdown();
  });
});
