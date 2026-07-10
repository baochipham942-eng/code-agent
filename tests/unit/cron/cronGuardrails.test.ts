// ============================================================================
// Cron 护栏回归测试 — maka A5 automation 护栏自查补丁（2026-07-10）
// 覆盖：触发 jitter 防惊群 / protect 防重叠 / startAt-endAt 生效 /
//       过期一次性任务停用 / 连续失败自动停用
// ============================================================================
import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

const dbState = vi.hoisted(() => ({
  cronRows: [] as unknown[],
  savedRows: [] as unknown[][],
}));

const automationState = vi.hoisted(() => ({
  recordCreated: vi.fn(async () => undefined),
  recordEvent: vi.fn(async () => undefined),
  getBySourceRef: vi.fn(() => null),
  upsert: vi.fn(() => undefined),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
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

vi.mock('../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => automationState,
}));

import { CronService, computeCronFireJitterMs } from '../../../src/host/cron/cronService';
import { CRON_GUARDRAILS } from '../../../src/shared/constants';
import type { Cron } from 'croner';

afterEach(() => {
  dbState.cronRows = [];
  dbState.savedRows = [];
  automationState.recordCreated.mockClear();
  automationState.recordEvent.mockClear();
  automationState.getBySourceRef.mockClear();
  automationState.getBySourceRef.mockReturnValue(null);
  automationState.upsert.mockClear();
});

function getInternalCronInstance(service: CronService, jobId: string): Cron | undefined {
  const jobs = (service as unknown as { jobs: Map<string, { cronInstance?: Cron }> }).jobs;
  return jobs.get(jobId)?.cronInstance;
}

describe('cron 触发 jitter（防惊群）', () => {
  it('一次性 at 任务不抖动', () => {
    expect(computeCronFireJitterMs('at', () => 0.999)).toBe(0);
  });

  it('every/cron 任务抖动落在 [0, FIRE_JITTER_MAX_MS) 内', () => {
    expect(computeCronFireJitterMs('every', () => 0)).toBe(0);
    expect(computeCronFireJitterMs('every', () => 0.999)).toBe(
      Math.floor(0.999 * CRON_GUARDRAILS.FIRE_JITTER_MAX_MS),
    );
    expect(computeCronFireJitterMs('cron', () => 0.5)).toBeLessThan(CRON_GUARDRAILS.FIRE_JITTER_MAX_MS);
  });
});

describe('cron 防重叠（protect）与调度窗口（startAt/endAt）', () => {
  it('every 任务的 croner 实例带 protect + startAt/stopAt', async () => {
    const service = new CronService();
    const startAt = Date.now() + 60 * 60_000;
    const endAt = Date.now() + 2 * 60 * 60_000;
    const job = await service.createJob({
      name: '窗口任务',
      scheduleType: 'every',
      schedule: { type: 'every', interval: 5, unit: 'minutes', startAt, endAt },
      action: { type: 'shell', command: 'echo ok' },
      enabled: true,
    });

    const instance = getInternalCronInstance(service, job.id);
    expect(instance).toBeDefined();
    expect(instance!.options.protect).toBeTruthy();
    // startAt 生效：首次触发不早于 startAt
    expect(instance!.nextRun()!.getTime()).toBeGreaterThanOrEqual(startAt);
    await service.shutdown();
  });

  it('endAt 已过期的 every 任务不再有下次触发（旧行为：endAt 被静默忽略照跑）', async () => {
    const service = new CronService();
    const job = await service.createJob({
      name: '已过期窗口任务',
      scheduleType: 'every',
      schedule: { type: 'every', interval: 5, unit: 'minutes', endAt: Date.now() - 60_000 },
      action: { type: 'shell', command: 'echo ok' },
      enabled: true,
    });

    expect(service.getJob(job.id)?.nextRunAt).toBeUndefined();
    await service.shutdown();
  });

  it('cron 表达式任务同样带 protect', async () => {
    const service = new CronService();
    const job = await service.createJob({
      name: '表达式任务',
      scheduleType: 'cron',
      schedule: { type: 'cron', expression: '0 0 3 * * *' },
      action: { type: 'shell', command: 'echo ok' },
      enabled: true,
    });

    expect(getInternalCronInstance(service, job.id)!.options.protect).toBeTruthy();
    await service.shutdown();
  });
});

describe('过期一次性任务加载时停用（防僵尸 enabled 任务）', () => {
  it('datetime 已过的 enabled at 任务：加载即停用并落库', async () => {
    dbState.cronRows = [
      {
        id: 'job-missed-at',
        name: '错过窗口的一次性任务',
        description: null,
        schedule_type: 'at',
        schedule: JSON.stringify({ type: 'at', datetime: Date.now() - 60_000 }),
        action: JSON.stringify({ type: 'shell', command: 'echo ok' }),
        enabled: 1,
        max_retries: 0,
        retry_delay: 5000,
        timeout: 60000,
        tags: null,
        metadata: '{}',
        created_at: Date.now() - 120_000,
        updated_at: Date.now() - 120_000,
      },
    ];
    const service = new CronService();

    await service.initialize();

    const job = service.getJob('job-missed-at');
    expect(job).not.toBeNull();
    expect(job!.enabled).toBe(false);
    // 落库：INSERT OR REPLACE 参数第 7 位是 enabled，应写 0
    const saved = dbState.savedRows.find((row) => row[0] === 'job-missed-at');
    expect(saved?.[6]).toBe(0);
    await service.shutdown();
  });

  it('datetime 还在将来的 enabled at 任务照常注册', async () => {
    dbState.cronRows = [
      {
        id: 'job-future-at',
        name: '将来的一次性任务',
        description: null,
        schedule_type: 'at',
        schedule: JSON.stringify({ type: 'at', datetime: Date.now() + 60 * 60_000 }),
        action: JSON.stringify({ type: 'shell', command: 'echo ok' }),
        enabled: 1,
        max_retries: 0,
        retry_delay: 5000,
        timeout: 60000,
        tags: null,
        metadata: '{}',
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ];
    const service = new CronService();

    await service.initialize();

    const job = service.getJob('job-future-at');
    expect(job!.enabled).toBe(true);
    expect(job!.nextRunAt).toBeGreaterThan(Date.now());
    await service.shutdown();
  });
});

describe('连续失败自动停用', () => {
  it(`循环任务连续失败 ${CRON_GUARDRAILS.MAX_CONSECUTIVE_FAILURES} 次后自动停用`, async () => {
    const service = new CronService();
    const job = await service.createJob({
      name: '总在失败的任务',
      scheduleType: 'every',
      schedule: { type: 'every', interval: 12, unit: 'hours' },
      action: { type: 'shell', command: 'exit 1' },
      enabled: true,
    });

    for (let i = 0; i < CRON_GUARDRAILS.MAX_CONSECUTIVE_FAILURES - 1; i++) {
      await service.triggerJob(job.id);
      expect(service.getJob(job.id)!.enabled).toBe(true);
    }
    await service.triggerJob(job.id);

    expect(service.getJob(job.id)!.enabled).toBe(false);
    await service.shutdown();
  });

  it('中途成功一次会重置连续失败计数', async () => {
    const service = new CronService();
    const job = await service.createJob({
      name: '偶尔成功的任务',
      scheduleType: 'every',
      schedule: { type: 'every', interval: 12, unit: 'hours' },
      action: { type: 'shell', command: 'exit 1' },
      enabled: true,
    });

    for (let i = 0; i < CRON_GUARDRAILS.MAX_CONSECUTIVE_FAILURES - 1; i++) {
      await service.triggerJob(job.id);
    }
    // 换成能成功的命令跑一次，重置 trailing 计数
    await service.updateJob(job.id, { action: { type: 'shell', command: 'true' } });
    await service.triggerJob(job.id);
    // 再换回失败命令：还差阈值次数才会停用
    await service.updateJob(job.id, { action: { type: 'shell', command: 'exit 1' } });
    await service.triggerJob(job.id);

    expect(service.getJob(job.id)!.enabled).toBe(true);
    await service.shutdown();
  });

  it('一次性 at 任务失败不触发连续失败停用逻辑（本来就单发）', async () => {
    const service = new CronService();
    const job = await service.createJob({
      name: '一次性失败任务',
      scheduleType: 'at',
      schedule: { type: 'at', datetime: Date.now() + 60 * 60_000 },
      action: { type: 'shell', command: 'exit 1' },
      enabled: true,
    });

    await service.triggerJob(job.id);

    // at 任务执行后按原有语义停用，且不因"连续失败"路径抛错
    expect(service.getJob(job.id)!.enabled).toBe(false);
    await service.shutdown();
  });
});
