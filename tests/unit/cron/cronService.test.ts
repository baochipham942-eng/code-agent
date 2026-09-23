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

const configState = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));

const channelState = vi.hoisted(() => ({
  // 通道契约是 SendMessageResult；返回 undefined 的桩不忠实于真实通道，
  // 而新实现要看这个返回值来判断平台有没有拒发。
  sendMessage: vi.fn(async (_accountId: string, _chatId: string, _text: string): Promise<{ success: boolean; messageId?: string; error?: string }> => ({ success: true, messageId: 'om_stub' })),
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
  getConfigService: () => ({ onSettingsUpdated: vi.fn(), getSettings: () => ({ ui: { language: configState.language } }) }),
}));

vi.mock('../../../src/host/channels/channelManager', () => ({
  getChannelManager: () => ({
    getAllAccounts: () => [{ id: 'feishu-account', type: 'feishu', name: '工作飞书' }],
    sendMessage: channelState.sendMessage,
  }),
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

const agentRunState = vi.hoisted(() => ({
  // 真实形状：AgentOrchestrator.sendMessage 是 Promise<void>，返回值恒 undefined；
  // 推送正文只能来自 getMessages() 里最后一条 assistant 消息（PR#2060 ai-review Important）。
  sendMessage: vi.fn(async () => undefined),
  messages: [] as Array<{ role: string; content: string }>,
}));

vi.mock('../../../src/host/task', () => ({
  getTaskManager: () => ({
    getOrCreateCurrentOrchestrator: () => ({
      setExecutionTopology: () => undefined,
      sendMessage: agentRunState.sendMessage,
      getMessages: () => agentRunState.messages,
    }),
    setWorkingDirectory: () => undefined,
    cleanup: () => undefined,
  }),
}));

// executeAction 的 agent 分支用动态 import('../services') 建 cron 会话；
// 只替身这两个入口，仓内其它模块都不从 barrel 取东西。
vi.mock('../../../src/host/services', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: 'zh' } }) }),
  getSessionManager: () => ({
    getCurrentSessionId: () => null,
    getSession: async () => null,
    createSession: async () => ({ id: 'cron-agent-session-1' }),
  }),
}));

vi.mock('../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => automationState,
}));

import { CronService } from '../../../src/host/cron/cronService';
import { pushCronResult } from '../../../src/host/cron/cronResultDelivery';
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
  configState.language = 'zh';
  channelState.sendMessage.mockClear();
  agentRunState.sendMessage.mockReset();
  agentRunState.sendMessage.mockImplementation(async () => undefined);
  agentRunState.messages = [];
  automationState.recordCreated.mockClear();
  automationState.recordEvent.mockClear();
  automationState.getBySourceRef.mockClear();
  automationState.getBySourceRef.mockReturnValue(null);
  automationState.upsert.mockClear();
  shutdownEventBus();
});

function installCloudClient(
  service: CronService,
  overrides: Partial<{
    addJob: (definition: import('../../../src/shared/contract/cron').CronJobDefinition) => Promise<string>;
    updateJob: (definition: import('../../../src/shared/contract/cron').CronJobDefinition) => Promise<void>;
    removeJob: (id: string) => Promise<void>;
    runJob: (id: string) => Promise<unknown>;
  }> = {},
) {
  type Definition = import('../../../src/shared/contract/cron').CronJobDefinition;
  const runtime = {
    isConfigured: () => false,
    start: vi.fn(),
    stop: vi.fn(),
    reconcile: vi.fn(async () => undefined),
    addJob: vi.fn(async (definition: Definition) => {
      const remoteJobId = await (overrides.addJob ?? (async () => 'remote-job-1'))(definition);
      const jobs = (service as unknown as {
        jobs: Map<string, { cloudJobId?: string }>;
      }).jobs;
      const active = jobs.get(definition.id);
      if (active) active.cloudJobId = remoteJobId;
      return remoteJobId;
    }),
    updateJob: vi.fn(overrides.updateJob ?? (async () => undefined)),
    removeJob: vi.fn(async (_definition: Definition, remoteJobId?: string) => {
      await (overrides.removeJob ?? (async () => undefined))(remoteJobId ?? 'remote-job-1');
      return true;
    }),
    runJob: vi.fn(async (_definition: Definition) => {
      try {
        return await (overrides.runJob ?? (async () => ({ ran: true, runId: 'remote-run-1' })))('remote-job-1');
      } catch (error) {
        throw new Error('云端计划任务服务暂时不可用，任务未执行。请检查云端执行地址和令牌后重试。', {
          cause: error,
        });
      }
    }),
  };
  (service as unknown as { cloudRuntime: typeof runtime }).cloudRuntime = runtime;
  return runtime;
}

describe('CronService execution location invariants', () => {
  it('does not create a local cron timer for an enabled cloud job', async () => {
    const service = new CronService();
    const cloudClient = installCloudClient(service);

    const job = await service.createJob({
      ...shellJob('hours'),
      runsOn: 'cloud',
      enabled: true,
    });

    const active = (service as unknown as {
      jobs: Map<string, { cronInstance?: unknown; cloudJobId?: string }>;
    }).jobs.get(job.id);
    expect(active?.cronInstance).toBeUndefined();
    expect(active?.cloudJobId).toBe('remote-job-1');
    expect(job.nextRunAt).toBeUndefined();
    expect(cloudClient.addJob).toHaveBeenCalledTimes(1);
    await service.shutdown();
  });

  it('mirrors cloud create, update, and remove through the remote lifecycle', async () => {
    const service = new CronService();
    const cloudClient = installCloudClient(service);
    const job = await service.createJob({
      ...shellJob('hours'),
      runsOn: 'cloud',
      enabled: false,
    });

    await service.updateJob(job.id, { name: 'Updated cloud job', enabled: true });
    await expect(service.deleteJob(job.id)).resolves.toBe(true);

    expect(cloudClient.addJob).toHaveBeenCalledTimes(1);
    expect(cloudClient.updateJob).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Updated cloud job',
      enabled: true,
    }));
    expect(cloudClient.removeJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: job.id }),
      'remote-job-1',
    );
    expect(service.getJob(job.id)).toBeNull();
  });

  it('freezes runsOn at creation in the service update path', async () => {
    const service = new CronService();
    const job = await service.createJob({
      ...shellJob('hours'),
      runsOn: 'cloud',
      enabled: false,
    });

    await expect(service.updateJob(job.id, { runsOn: 'local' })).rejects.toThrow(
      'runsOn is immutable after creation',
    );
    expect(service.getJob(job.id)?.runsOn).toBe('cloud');
  });

  it('rejects cloud intervals below one hour while preserving local minute schedules', async () => {
    const service = new CronService();

    await expect(service.createJob({
      ...shellJob('minutes'),
      runsOn: 'cloud',
      schedule: { type: 'every', interval: 59, unit: 'minutes' },
    })).rejects.toThrow('at least 3600 seconds');

    await expect(service.createJob({
      ...shellJob('hours'),
      runsOn: 'cloud',
      scheduleType: 'cron',
      schedule: { type: 'cron', expression: '*/30 * * * *' },
    })).rejects.toThrow('at least 3600 seconds');

    await expect(service.createJob({
      ...shellJob('minutes'),
      runsOn: 'local',
      schedule: { type: 'every', interval: 1, unit: 'minutes' },
      enabled: false,
    })).resolves.toMatchObject({ runsOn: 'local' });

    await expect(service.createJob({
      ...shellJob('seconds'),
      runsOn: 'local',
      schedule: { type: 'every', interval: 59, unit: 'seconds' },
    })).rejects.toThrow('at least 60 seconds');
  });

  it('branches cloud runs before local executeAction and leaves local runs unchanged', async () => {
    const service = new CronService();
    const cloudClient = installCloudClient(service, {
      runJob: async () => { throw new Error('network down'); },
    });
    const executeAction = vi.fn(async () => ({ ok: true }));
    (service as unknown as { executeAction: typeof executeAction }).executeAction = executeAction;
    const cloudJob = await service.createJob({
      name: 'Cloud agent run',
      runsOn: 'cloud',
      scheduleType: 'every',
      schedule: { type: 'every', interval: 1, unit: 'hours' },
      action: { type: 'agent', agentType: 'default', prompt: 'work' },
      enabled: false,
      maxRetries: 1,
    });
    const localJob = await service.createJob({
      name: 'Local agent run',
      runsOn: 'local',
      scheduleType: 'every',
      schedule: { type: 'every', interval: 1, unit: 'minutes' },
      action: { type: 'agent', agentType: 'default', prompt: 'work' },
      enabled: false,
    });

    const cloudExecution = await service.triggerJob(cloudJob.id);
    expect(cloudExecution).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('云端计划任务服务暂时不可用'),
    });
    expect(cloudClient.runJob).toHaveBeenCalledWith(expect.objectContaining({ id: cloudJob.id }));
    expect(dbState.savedRows).toContainEqual(expect.arrayContaining([
      expect.any(String), cloudJob.id, null, 'failed',
    ]));
    expect(executeAction).not.toHaveBeenCalled();

    const localExecution = await service.triggerJob(localJob.id);
    expect(localExecution).toMatchObject({ status: 'completed', result: { ok: true } });
    expect(executeAction).toHaveBeenCalledTimes(1);
    expect(executeAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: localJob.id, runsOn: 'local' }),
      localJob.action,
      undefined,
      expect.any(String),
    );
  });
});

describe('CronService result channel delivery', () => {
  function resultJob(overrides: Partial<import('../../../src/shared/contract/cron').CronJobDefinition> = {}) {
    return {
      id: 'result-job',
      name: 'Result job',
      runsOn: 'local' as const,
      scheduleType: 'every' as const,
      schedule: { type: 'every' as const, interval: 1, unit: 'hours' as const },
      action: { type: 'agent' as const, agentType: 'default', prompt: 'work' },
      enabled: false,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  // 断言原为 sendMessage('feishu-account', 'feishu-account', …)，即把账号 id 当会话 id 传。
  // 那不是产品决定，是镜像了实现缺陷：飞书实测拿账号 uuid 当 receive_id 一律回
  // 230001 invalid receive_id（2026-08-24 真机），也就是说这条断言绿着、结果永远到不了群里。
  // 现改为「会话 id 必须原样传给通道」。
  it('pushes a normal cron result to the conversation named by the target', async () => {
    const definition = resultJob({ resultChannel: 'feishu:oc_group1' });
    await expect(pushCronResult(definition, 'normal result')).resolves.toEqual({ delivered: true, pushedBody: 'normal result' });

    expect(channelState.sendMessage).toHaveBeenCalledWith(
      'feishu-account',
      'oc_group1',
      'normal result',
    );
  });

  it('refuses to deliver when the target names no conversation', async () => {
    const definition = resultJob({ resultChannel: 'feishu' });
    const outcome = await pushCronResult(definition, 'normal result');

    expect(outcome.delivered).toBe(false);
    expect(outcome.reason).toContain('no conversation id');
    expect(channelState.sendMessage).not.toHaveBeenCalled();
  });

  it('does not push a normal cron result without a configured channel', async () => {
    const definition = resultJob();
    await pushCronResult(definition, 'quiet result');

    expect(channelState.sendMessage).not.toHaveBeenCalled();
  });

  // 心跳那条老路走同一个函数，所以同样需要会话 id。原断言（账号 id 传两遍）同上：
  // 绿着但发不出去，故「保持不变」保住的是一个坏行为。
  it('delivers heartbeat results to the conversation named in the context channel', async () => {
    const definition = resultJob({
      action: {
        type: 'agent',
        agentType: 'heartbeat',
        prompt: 'check',
        context: { heartbeatTask: true, channel: 'feishu:oc_group1' },
      },
    });
    await expect(pushCronResult(definition, 'heartbeat result')).resolves.toEqual({ delivered: true, pushedBody: 'heartbeat result' });

    expect(channelState.sendMessage).toHaveBeenCalledWith(
      'feishu-account',
      'oc_group1',
      'heartbeat result',
    );
  });
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
    expect(dbState.savedRows.some((row) => row[0] === 'job-at-missed' && row[11] === 0)).toBe(true);
    unsubscribe();
    await service.shutdown();
  });

  it('traces a missed recurring tick and keeps its next run scheduled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    configState.language = 'en';
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
      content: expect.stringContaining('Its next run remains scheduled'),
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
    expect(job.runsOn).toBe('local');
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
    expect(JSON.parse(String(dbState.savedRows.at(-1)?.[16]))).toMatchObject({
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


describe('N-CRON-ACTIONGATE unsupported actions', () => {
  it.each([
    { type: 'tool', toolName: 'Read', parameters: { file_path: '/tmp/cron-test' } },
    { type: 'ipc', channel: 'session:list', payload: {} },
  ] satisfies import('../../../src/shared/contract/cron').CronJobAction[])(
    '$type 不执行占位任务，也不能留下 completed 记录', async (action) => {
      const service = new CronService();
      const job = await service.createJob({
        name: `unsupported ${action.type}`, runsOn: 'local', enabled: false,
        scheduleType: 'every', schedule: { type: 'every', interval: 1, unit: 'hours' },
        action, maxRetries: 3, retryDelay: 1,
      });
      const execution = await service.triggerJob(job.id);
      expect(execution).toMatchObject({ status: 'failed', error: 'unsupported_action', retryAttempt: 0 });
      if (!execution) throw new Error('Expected an execution record');
      expect(execution.result).toBeUndefined();
      const stored = dbState.savedRows.filter((row) => row[0] === execution.id).at(-1);
      expect(stored).toEqual(expect.arrayContaining([execution.id, job.id, 'failed', 'unsupported_action']));
    },
  );
});


describe('N-CRON-SKIPPED-DELIVERY quiet watch rounds', () => {
  function agentJob(context: Record<string, unknown>) {
    return {
      name: '飞书日历监听',
      runsOn: 'local' as const,
      scheduleType: 'every' as const,
      schedule: { type: 'every' as const, interval: 15, unit: 'minutes' as const },
      action: { type: 'agent' as const, agentType: 'default', prompt: '盯日历变更', context },
      resultChannel: 'feishu:oc_group1',
      enabled: false,
    };
  }

  // 验收①：无 <cron_alert> 的监听轮整成 skipped，且一个字都不许推到通道。
  // 反向变异：把 deliverCronResult 挪回 skipped 判定之前，这条必须红。
  it('does not push a quiet external_watch round and records it as skipped', async () => {
    agentRunState.messages = [{ role: 'assistant', content: '本轮巡检：没有新变化。' }];
    const service = new CronService();
    const job = await service.createJob(agentJob({
      externalWatch: { source: 'feishu-calendar', calendarId: 'cal-1' },
    }));

    const execution = await service.triggerJob(job.id);
    if (!execution) throw new Error('Expected an execution record');

    expect(execution).toMatchObject({ status: 'completed' });
    expect(execution.result).toMatchObject({ skipped: true, reason: 'no_new_event' });
    expect(channelState.sendMessage).not.toHaveBeenCalled();
    await service.shutdown();
  });

  // 验收②：有 <cron_alert> 的监听轮照推，且真推成功后把正文记成 lastPushed。
  // 正文来自 getMessages() 的最后一条 assistant 消息——sendMessage 的真实返回是 void。
  // 推送前清洗（PR#2060 第二轮）：剥 <cron_snapshot> 内部状态块，只推 <cron_alert> 内文，
  // 标签壳与快照原文都不许进通道。
  it('pushes an external_watch round that carries a cron_alert', async () => {
    const assistantText = '例行巡检完成。\n<cron_snapshot>{"conflicts":2,"rows":"指纹"}</cron_snapshot>\n<cron_alert>新增冲突：明天十点双会</cron_alert>';
    agentRunState.messages = [{ role: 'assistant', content: assistantText }];
    const service = new CronService();
    const job = await service.createJob(agentJob({
      externalWatch: { source: 'feishu-calendar', calendarId: 'cal-1' },
    }));

    const execution = await service.triggerJob(job.id);
    if (!execution) throw new Error('Expected an execution record');

    expect(execution).toMatchObject({ status: 'completed' });
    expect(execution.result).not.toMatchObject({ skipped: true });
    expect(channelState.sendMessage).toHaveBeenCalledWith('feishu-account', 'oc_group1', '新增冲突：明天十点双会');
    const pushedBody = channelState.sendMessage.mock.calls[0]?.[2] as string;
    expect(pushedBody).not.toContain('<cron_snapshot>');
    expect(pushedBody).not.toContain('<cron_alert>');
    expect(service.getJob(job.id)?.action).toMatchObject({
      context: { lastPushedResult: '新增冲突：明天十点双会' },
    });
    await service.shutdown();
  });

  // 验收②：非监听任务不受 skipped 门影响，每轮照推；<cron_snapshot> 块同样不许进通道。
  it('keeps pushing non-watch agent jobs as before', async () => {
    agentRunState.messages = [{ role: 'assistant', content: '日报正文\n<cron_snapshot>{"done":3}</cron_snapshot>' }];
    const service = new CronService();
    const job = await service.createJob(agentJob({}));

    const execution = await service.triggerJob(job.id);
    if (!execution) throw new Error('Expected an execution record');

    expect(execution).toMatchObject({ status: 'completed' });
    expect(execution.result).not.toMatchObject({ skipped: true });
    expect(channelState.sendMessage).toHaveBeenCalledWith('feishu-account', 'oc_group1', '日报正文');
    await service.shutdown();
  });

  // 验收③：lastPushed 只在真推成功后更新——推失败时同正文下一轮仍照推；
  // 真推成功后同正文不再推，差一字照推。
  it('updates lastPushed only after a successful push and skips byte-identical bodies', async () => {
    const service = new CronService();
    const job = await service.createJob(agentJob({}));

    agentRunState.messages = [{ role: 'assistant', content: '正文A' }];
    await service.triggerJob(job.id);
    expect(channelState.sendMessage).toHaveBeenCalledTimes(1);
    expect(service.getJob(job.id)?.action).toMatchObject({ context: { lastPushedResult: '正文A' } });

    // 平台拒发：lastPushed 不许更新。
    agentRunState.messages = [{ role: 'assistant', content: '正文B' }];
    channelState.sendMessage.mockResolvedValueOnce({ success: false, error: 'invalid receive_id' });
    await service.triggerJob(job.id);
    expect(channelState.sendMessage).toHaveBeenCalledTimes(2);
    expect(service.getJob(job.id)?.action).toMatchObject({ context: { lastPushedResult: '正文A' } });

    // 上轮没推成，同正文这一轮仍照推（不受去重拦截）。
    await service.triggerJob(job.id);
    expect(channelState.sendMessage).toHaveBeenCalledTimes(3);
    expect(service.getJob(job.id)?.action).toMatchObject({ context: { lastPushedResult: '正文B' } });

    // 真推成功后，一字不差的正文不再推。
    await service.triggerJob(job.id);
    expect(channelState.sendMessage).toHaveBeenCalledTimes(3);

    await service.shutdown();
  });
});
