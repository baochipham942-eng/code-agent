import { afterEach, describe, expect, it, vi } from 'vitest';

const dbState = vi.hoisted(() => ({
  cronRows: [] as unknown[],
  savedRows: [] as unknown[][],
  lastRunAt: new Map<string, number>(),
  sessionIds: new Set<string>(),
}));

const sessionState = vi.hoisted(() => ({
  messages: new Map<string, Array<import('../../../src/shared/contract').Message>>(),
  broadcasts: [] as unknown[],
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
        get: (jobId: string) => (
          sql.includes('MAX(started_at)')
            ? { last_run_at: dbState.lastRunAt.get(jobId) ?? null }
            : undefined
        ),
        run: (...args: unknown[]) => {
          dbState.savedRows.push(args);
          return { changes: 0 };
        },
      }),
    }),
    getSession: (sessionId: string) => (dbState.sessionIds.has(sessionId) ? { id: sessionId } : null),
  }),
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: 'zh' } }) }),
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    addMessageToSession: async (sessionId: string, message: import('../../../src/shared/contract').Message) => {
      const messages = sessionState.messages.get(sessionId) ?? [];
      messages.push(message);
      sessionState.messages.set(sessionId, messages);
    },
    getMessages: async (sessionId: string) => sessionState.messages.get(sessionId) ?? [],
  }),
}));

vi.mock('../../../src/host/platform', () => ({
  broadcastToRenderer: (...args: unknown[]) => sessionState.broadcasts.push(args),
}));

vi.mock('../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => automationState,
}));

import { CronService } from '../../../src/host/cron/cronService';
import { formatCronMissedMessage } from '../../../src/host/cron/cronMissedTrace';
import { getEventBus, shutdownEventBus } from '../../../src/host/services/eventing/bus';
import { getSessionManager } from '../../../src/host/services/infra/sessionManager';

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
  dbState.lastRunAt.clear();
  dbState.sessionIds.clear();
  sessionState.messages.clear();
  sessionState.broadcasts = [];
  automationState.recordCreated.mockClear();
  automationState.recordEvent.mockClear();
  automationState.getBySourceRef.mockClear();
  automationState.getBySourceRef.mockReturnValue(null);
  automationState.upsert.mockClear();
  shutdownEventBus();
});

function persistedJob(input: {
  id: string;
  name: string;
  scheduleType: 'at' | 'every' | 'cron';
  schedule: Record<string, unknown>;
  sourceSessionId?: string;
  createdAt?: number;
}) {
  return {
    id: input.id,
    name: input.name,
    description: null,
    schedule_type: input.scheduleType,
    schedule: JSON.stringify(input.schedule),
    action: JSON.stringify({ type: 'shell', command: 'echo ok' }),
    enabled: 1,
    max_retries: 0,
    retry_delay: 5000,
    timeout: 60000,
    tags: null,
    metadata: JSON.stringify(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
    created_at: input.createdAt ?? NOW - 60 * 60_000,
    updated_at: input.createdAt ?? NOW - 60 * 60_000,
  };
}

describe('CronService missed schedule traces', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats the persisted human message in zh/en', () => {
    expect(formatCronMissedMessage({ name: 'Daily brief' }, NOW, true, 'zh')).toContain('已停用');
    expect(formatCronMissedMessage({ name: 'Daily brief' }, NOW, true, 'en')).toContain('has been disabled');
  });

  it('disables an overdue one-time job, writes a system message, and emits cron.missed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    dbState.sessionIds.add('source-at');
    dbState.cronRows = [persistedJob({
      id: 'job-at-missed',
      name: '离线提醒',
      scheduleType: 'at',
      schedule: { type: 'at', datetime: NOW - 30 * 60_000 },
      sourceSessionId: 'source-at',
    })];
    const events: unknown[] = [];
    const unsubscribe = getEventBus().subscribe('system:cron.missed', (event) => { events.push(event.data); });
    const service = new CronService();

    await service.initialize();

    const messages = await getSessionManager().getMessages('source-at');
    expect(messages).toEqual([expect.objectContaining({
      role: 'system',
      content: expect.stringContaining('在应用离线期间被错过，已停用'),
    })]);
    expect(events).toEqual([{
      jobId: 'job-at-missed',
      scheduledAt: NOW - 30 * 60_000,
      reason: 'app-offline',
    }]);
    expect(service.getJob('job-at-missed')).toMatchObject({ enabled: false });
    expect(dbState.savedRows.some((row) => row[0] === 'job-at-missed' && row[6] === 0)).toBe(true);
    unsubscribe();
    await service.shutdown();
  });

  it('traces a missed recurring tick and keeps its next run scheduled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    dbState.sessionIds.add('source-recurring');
    dbState.cronRows = [persistedJob({
      id: 'job-recurring-missed',
      name: '周期巡检',
      scheduleType: 'cron',
      schedule: { type: 'cron', expression: '*/15 * * * *' },
      sourceSessionId: 'source-recurring',
    })];
    dbState.lastRunAt.set('job-recurring-missed', NOW - 30 * 60_000);
    const events: unknown[] = [];
    const unsubscribe = getEventBus().subscribe('system:cron.missed', (event) => { events.push(event.data); });
    const service = new CronService();

    await service.initialize();

    const messages = await getSessionManager().getMessages('source-recurring');
    expect(messages).toEqual([expect.objectContaining({
      role: 'system',
      content: expect.stringContaining('后续仍按原计划运行'),
    })]);
    expect(events).toEqual([expect.objectContaining({
      jobId: 'job-recurring-missed',
      scheduledAt: NOW - 15 * 60_000,
      reason: 'app-offline',
    })]);
    expect(service.getJob('job-recurring-missed')).toMatchObject({
      enabled: true,
      nextRunAt: NOW + 15 * 60_000,
    });
    unsubscribe();
    await service.shutdown();
  });

  it('does not trace a recurring job that ran after the previous scheduled tick', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    dbState.sessionIds.add('source-current');
    dbState.cronRows = [persistedJob({
      id: 'job-current',
      name: '正常巡检',
      scheduleType: 'cron',
      schedule: { type: 'cron', expression: '*/15 * * * *' },
      sourceSessionId: 'source-current',
    })];
    dbState.lastRunAt.set('job-current', NOW - 10 * 60_000);
    const events: unknown[] = [];
    const unsubscribe = getEventBus().subscribe('system:cron.missed', (event) => { events.push(event.data); });
    const service = new CronService();

    await service.initialize();

    expect(await getSessionManager().getMessages('source-current')).toEqual([]);
    expect(events).toEqual([]);
    expect(service.getJob('job-current')?.nextRunAt).toBe(NOW + 15 * 60_000);
    unsubscribe();
    await service.shutdown();
  });

  it('routes a missed trace to the automation inbox when the target session is gone', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    dbState.cronRows = [persistedJob({
      id: 'job-orphaned',
      name: '已删会话任务',
      scheduleType: 'at',
      schedule: { type: 'at', datetime: NOW - 5 * 60_000 },
      sourceSessionId: 'deleted-session',
    })];
    const service = new CronService();

    await service.initialize();

    expect(automationState.upsert).toHaveBeenCalledWith(expect.objectContaining({
      id: 'cron:job-orphaned',
      status: 'pending_review',
      config: expect.objectContaining({
        pendingReview: { at: NOW - 5 * 60_000 },
        missedNotice: { scheduledAt: NOW - 5 * 60_000, reason: 'app-offline' },
      }),
    }));
    expect(await getSessionManager().getMessages('deleted-session')).toEqual([]);
    await service.shutdown();
  });
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
