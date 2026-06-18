import { afterEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../../../src/main/services/sessionAutomation', () => ({
  getSessionAutomationService: () => automationState,
}));

import { CronService } from '../../../src/main/cron/cronService';

const NOW = Date.UTC(2026, 5, 12, 9, 0, 0);

// unit 用 string：weeks 已从 TimeUnit 移除（audit 复核 HIGH-2），但运行时仍需测
// "传入非法 weeks → 拒绝"的防御路径，故此处刻意放宽类型构造非法输入。
function shellJob(unit: 'seconds' | 'minutes' | 'hours' | 'days' | 'weeks') {
  return {
    name: `Every 3 ${unit}`,
    scheduleType: 'every' as const,
    schedule: { type: 'every' as const, interval: 3, unit: unit as 'seconds' },
    action: { type: 'shell' as const, command: 'echo ok' },
    enabled: true,
  };
}

afterEach(() => {
  dbState.cronRows = [];
  dbState.savedRows = [];
  automationState.recordCreated.mockClear();
  automationState.recordEvent.mockClear();
  automationState.getBySourceRef.mockClear();
  automationState.getBySourceRef.mockReturnValue(null);
  automationState.upsert.mockClear();
});

describe('CronService every schedule units', () => {
  it('rejects weeks at the type layer — createJob cannot be called with unit:weeks (audit HIGH-2)', () => {
    // @ts-expect-error weeks 已从 TimeUnit 移除：合法 API 调用编译期即拒绝，不再类型说谎
    const bad: import('../../../src/shared/contract/cron').EveryScheduleConfig = { type: 'every', interval: 1, unit: 'weeks' };
    void bad;
  });

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

  it('records source-session automation metadata for slash-created agent schedules', async () => {
    const service = new CronService();

    const job = await service.createJob({
      name: '主题页编排巡检',
      description: '自动巡检主线',
      scheduleType: 'every',
      schedule: { type: 'every', interval: 15, unit: 'minutes' },
      action: {
        type: 'agent',
        agentType: 'default',
        prompt: '检查线程状态',
        context: { sourceSessionId: 'source-session-1' },
      },
      enabled: true,
      metadata: {
        sourceSessionId: 'source-session-1',
        createdVia: 'slash_schedule',
      },
    });

    expect(automationState.recordCreated).toHaveBeenCalledWith(expect.objectContaining({
      id: `cron:${job.id}`,
      sourceSessionId: 'source-session-1',
      type: 'cron',
      sourceRefId: job.id,
      cadenceLabel: '每 15 分钟',
      config: expect.objectContaining({
        createdVia: 'slash_schedule',
        actionType: 'agent',
      }),
    }));
    expect(JSON.parse(String(dbState.savedRows.at(-1)?.[11]))).toMatchObject({
      sourceSessionId: 'source-session-1',
      createdVia: 'slash_schedule',
    });
    await service.shutdown();
  });

  it('writes a source-session automation message when deleting a slash-created schedule', async () => {
    const service = new CronService();

    const job = await service.createJob({
      name: '主题页编排巡检',
      scheduleType: 'every',
      schedule: { type: 'every', interval: 15, unit: 'minutes' },
      action: {
        type: 'agent',
        agentType: 'default',
        prompt: '检查线程状态',
        context: { sourceSessionId: 'source-session-1' },
      },
      enabled: true,
      metadata: {
        sourceSessionId: 'source-session-1',
        createdVia: 'slash_schedule',
      },
    });
    automationState.recordEvent.mockClear();
    automationState.upsert.mockClear();

    await service.deleteJob(job.id);

    expect(automationState.upsert).toHaveBeenCalledWith(expect.objectContaining({
      id: `cron:${job.id}`,
      sourceSessionId: 'source-session-1',
      type: 'cron',
      sourceRefId: job.id,
    }));
    expect(automationState.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'cron',
      sourceRefId: job.id,
      event: 'cancelled',
      status: 'cancelled',
      summary: '定时任务已删除。',
    }));
    await service.shutdown();
  });
});
