// ============================================================================
// 停用云端副本的真实服务测试（N-ROLE-ROUTINE-RESTATE-FU1-FU1）：
// copy-to-cloud 一律存 enabled:false 的副本。真 CronService + 真 CronCloudRuntime
// （云端未配置）下——
//   (a) 创建停用副本：不尝试注册云端，零执行记录（列表不再出现「latest: failed」）；
//   (b) 此刻启用：才第一次尝试注册，恰好落一条 failed 执行记录（用户刚按了启用，
//       失败出现在这一刻，与用户的动作对得上）；
//   (c) 已注册（map 里有 cloudJobId）的停用任务被更新：服务仍把更新推给
//       cloudRuntime.updateJob（推停用态）。
// cronService.test.ts 已 1400+ 行不再增长，新用例独立成文件。
// ============================================================================
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

const channelState = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_accountId: string, _chatId: string, _text: string): Promise<{ success: boolean; messageId?: string; error?: string }> => ({ success: true, messageId: 'om_stub' })),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

const automationState = vi.hoisted(() => ({
  recordCreated: vi.fn(async () => undefined),
  recordEvent: vi.fn(async () => undefined),
  getBySourceRef: vi.fn(() => null),
  upsert: vi.fn(() => undefined),
}));

/** 云端执行地址/令牌：默认不配置（(a)(b)(c) 与既有行为一致），仅新用例显式设置。 */
const configState = vi.hoisted(() => ({
  cronCloud: undefined as { baseUrl: string; token: string } | undefined,
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
  getConfigService: () => ({
    onSettingsUpdated: vi.fn(),
    // 云端执行地址/令牌默认未配置（真实 CronApiClient.requireConfig 会抛）；
    // 新用例通过 configState.cronCloud 显式打开，模拟已开通云端的用户。
    getSettings: () => ({
      ui: { language: 'zh' },
      ...(configState.cronCloud ? { cronCloud: configState.cronCloud } : {}),
    }),
  }),
}));

vi.mock('../../../src/host/channels/channelManager', () => ({
  getChannelManager: () => ({
    getAccount: () => undefined,
    getAllAccounts: () => [],
    sendMessage: channelState.sendMessage,
    on: channelState.on,
    removeListener: channelState.removeListener,
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

vi.mock('../../../src/host/task', () => ({
  getTaskManager: () => ({
    getOrCreateCurrentOrchestrator: () => ({
      setExecutionTopology: () => undefined,
      sendMessage: vi.fn(async () => undefined),
      getMessages: () => [],
    }),
    setWorkingDirectory: () => undefined,
    cleanup: () => undefined,
  }),
}));

vi.mock('../../../src/host/services', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: 'zh' } }) }),
  getSessionManager: () => ({
    getCurrentSessionId: () => null,
    getSession: async () => null,
    createSession: vi.fn(async () => ({ id: 'cron-agent-session-disabled-copy' })),
  }),
}));

vi.mock('../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => automationState,
}));

const artifactRefreshState = vi.hoisted(() => ({
  begin: vi.fn((_definition: unknown): unknown => undefined),
  finish: vi.fn(async (_state: unknown, _outcome: unknown): Promise<void> => undefined),
  cwd: vi.fn((_definition: unknown, fallback: string | undefined) => fallback),
}));

vi.mock('../../../src/host/cron/artifactStandingRefresh', () => ({
  beginArtifactRefresh: artifactRefreshState.begin,
  finishArtifactRefresh: artifactRefreshState.finish,
  cronAgentWorkingDirectory: artifactRefreshState.cwd,
}));

import { CronService } from '../../../src/host/cron/cronService';
import type { CronCloudRuntime } from '../../../src/host/cron/cronCloudRuntime';
import { shutdownEventBus } from '../../../src/host/services/eventing/bus';

/** 角色绑定 agent 任务（copy-to-cloud 副本的真实形状：runsOn=cloud、enabled=false）。 */
function disabledCloudCopy() {
  return {
    name: '牧之晨间简报 (云端)',
    runsOn: 'cloud' as const,
    enabled: false,
    scheduleType: 'every' as const,
    schedule: { type: 'every' as const, interval: 1, unit: 'hours' as const },
    action: { type: 'agent' as const, agentType: 'default' as const, prompt: '汇总今天的日程并给一段晨间简报', roleId: 'role-muzhi' },
  };
}

/** saveCronExecution 的 run 参数形如 [execId, jobId, sessionId, status, …]（job 行的 row[1] 是任务名，不会撞 jobId）。 */
function persistedExecutionsFor(jobId: string) {
  return dbState.savedRows.filter((row) => row[1] === jobId);
}

function realCloudRuntime(service: CronService): CronCloudRuntime {
  return (service as unknown as { cloudRuntime: CronCloudRuntime }).cloudRuntime;
}

/** CronApiClient 只读 ok / status / json()，不必构造真 Response。 */
function fakeOk(result: unknown) {
  return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
}

afterEach(() => {
  dbState.cronRows = [];
  dbState.savedRows = [];
  dbState.lastRunAt.clear();
  dbState.sessionIds.clear();
  sessionState.messages.clear();
  sessionState.broadcasts = [];
  configState.cronCloud = undefined;
  vi.unstubAllGlobals();
  shutdownEventBus();
});

describe('CronService 停用云端副本（真实 CronCloudRuntime · 云端未配置）', () => {
  it('(a) 创建停用云端副本：不注册云端，内存与落库的执行记录都为零', async () => {
    const service = new CronService();
    const job = await service.createJob(disabledCloudCopy());

    expect(job.enabled).toBe(false);
    expect(job.runsOn).toBe('cloud');
    // 内存执行历史为空
    expect(service.getJobExecutions(job.id)).toEqual([]);
    // 落库侧也没有任何执行行（旧实现注册即失败，会假写一条 status='failed'）
    expect(persistedExecutionsFor(job.id)).toEqual([]);
    await service.shutdown();
  });

  it('(b) 云端仍未配置时启用副本：此刻才第一次尝试注册，恰好一条 failed 执行记录', async () => {
    const service = new CronService();
    const job = await service.createJob(disabledCloudCopy());

    const enabled = await service.updateJob(job.id, { enabled: true });
    expect(enabled?.enabled).toBe(true);

    const executions = service.getJobExecutions(job.id);
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      jobId: job.id,
      runsOn: 'cloud',
      status: 'failed',
      duration: 0,
    });
    expect(executions[0]?.error).toContain('云端计划任务服务暂时不可用');
    // 落库侧恰好一条 failed 执行行
    expect(persistedExecutionsFor(job.id)).toHaveLength(1);
    await service.shutdown();
  });

  it('(c) 已注册的停用任务被更新：服务仍调用 cloudRuntime.updateJob 推停用态', async () => {
    const service = new CronService();
    const job = await service.createJob(disabledCloudCopy());
    // 模拟「创建时已注册成功」：map 条目上补 remote 指针
    const active = (service as unknown as {
      jobs: Map<string, { cloudJobId?: string }>;
    }).jobs.get(job.id);
    expect(active).toBeTruthy();
    active!.cloudJobId = 'remote-registered-1';

    const updateSpy = vi.spyOn(realCloudRuntime(service), 'updateJob');
    const updated = await service.updateJob(job.id, { name: '停用态改名' });

    expect(updated?.enabled).toBe(false);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: job.id,
      name: '停用态改名',
      enabled: false,
    }));
    await service.shutdown();
  });
});

// ============================================================================
// N-ROLE-ROUTINE-RESTATE-FU1-FU1-FU1：停用已注册的云端任务不许丢掉 remote 指针。
// updateJob 的停用分支曾用 `this.jobs.set(jobId, { definition: updatedJob })` 覆盖 map，
// 把 cloudJobId 抹掉；紧接着的 cloudRuntime.updateJob 查不到 id 就走惰性 addJob，
// 云端多出一条副本（打桩 id 从 remote-2 起递增；实测停用与改名各再注册一次），
// DB 指针也被改指过去，旧远端任务成了孤儿。
// 真 CronService + 真 CronCloudRuntime，只把网关 fetch 打桩。
// ============================================================================
describe('CronService 停用/改名已注册的云端任务（真实 CronCloudRuntime · 打桩云端网关）', () => {
  it('(d) 停用后再改名：只注册一次，改名走 remote-1 的 update，DB 与内存指针都不变', async () => {
    configState.cronCloud = { baseUrl: 'https://cloud.example.test', token: 'test-token' };

    const calls: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
    let addCount = 0;
    // 必须在 new CronService() 之前装好：CronApiClient 构造时把 fetch 收成默认参数。
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body == null
        ? undefined
        : JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ path, method: init?.method ?? 'GET', body });
      if (path === '/api/cron/add') {
        addCount += 1;
        return fakeOk({ id: `remote-${addCount}` });
      }
      if (path === '/api/cron/update') return fakeOk({});
      if (path === '/api/cron/list') return fakeOk({ jobs: [] });
      throw new Error(`unexpected cloud cron request: ${path}`);
    }));

    const service = new CronService();
    const job = await service.createJob({ ...disabledCloudCopy(), enabled: true });
    expect(job.enabled).toBe(true);

    await service.updateJob(job.id, { enabled: false });
    const renamed = await service.updateJob(job.id, { name: '停用后改名' });
    expect(renamed?.name).toBe('停用后改名');
    expect(renamed?.enabled).toBe(false);

    // 只注册过一条远端任务：停用/改名都不许再 add。
    const addCalls = calls.filter((call) => call.path === '/api/cron/add');
    expect(addCalls).toHaveLength(1);

    // 停用后的更新走 remote-1 的 update（不是惰性 add），改名 body 带着 remote-1。
    const updateCalls = calls.filter((call) => call.path === '/api/cron/update');
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    const renameUpdate = updateCalls.find(
      (call) => (call.body?.patch as Record<string, unknown> | undefined)?.name === '停用后改名',
    );
    expect(renameUpdate).toBeTruthy();
    expect(renameUpdate?.body?.id).toBe('remote-1');

    // 最后一次落库的 cron_jobs 行仍指向 remote-1（saveCronJob 第 13 个参数）。
    const jobRows = dbState.savedRows.filter((row) => row[0] === job.id);
    expect(jobRows.length).toBeGreaterThan(0);
    expect(jobRows[jobRows.length - 1]?.[12]).toBe('remote-1');

    // 内存里的活动条目也仍持有 remote-1。
    const active = (service as unknown as {
      jobs: Map<string, { cloudJobId?: string }>;
    }).jobs.get(job.id);
    expect(active?.cloudJobId).toBe('remote-1');

    await service.shutdown();
  });
});

// ============================================================================
// N-ROLE-ROUTINE-RESTATE-FU1-FU1-FU1-FU1：跨进程 reconcile 重建停用任务时不许丢
// 远端指针。reconcileJobsFromDatabase 的停用分支曾用 `this.jobs.set(id,
// { definition })` 整条覆盖 map 条目，把 cloudJobId 抹掉；下一趟 updateJob 走
// cloudRuntime.updateJob 查不到 remote id，惰性 addJob 在云端多注册一条副本，
// 旧远端任务成了孤儿。与 updateJob 停用分支（上方案例 d 钉住的行为）同一缺陷
// 的 reconcile 孪生。真 CronService + 真 CronCloudRuntime，只把网关 fetch 打桩。
// ============================================================================
describe('CronService 跨进程 reconcile 重建停用的云端任务（真实 CronCloudRuntime · 打桩云端网关）', () => {
  it('(e) 另一进程改库触发 reconcile 重建停用任务：指针保留，后续改名不再 add、DB 指针不变', async () => {
    const calls: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
    let addCount = 0;
    // 必须在 new CronService() 之前装好：CronApiClient 构造时把 fetch 收成默认参数。
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body == null
        ? undefined
        : JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ path, method: init?.method ?? 'GET', body });
      if (path === '/api/cron/add') {
        addCount += 1;
        return fakeOk({ id: `remote-${addCount}` });
      }
      if (path === '/api/cron/update') return fakeOk({});
      if (path === '/api/cron/list') return fakeOk({ jobs: [] });
      throw new Error(`unexpected cloud cron request: ${path}`);
    }));

    // initialize 在云端未配置时就绪：启动对账看到的内存任务是空表，SSE 客户端也不启动。
    // CronApiClient 逐请求读配置，之后再打开云端不影响后续 add/update 打到桩上。
    const service = new CronService();
    await service.initialize();
    configState.cronCloud = { baseUrl: 'https://cloud.example.test', token: 'test-token' };

    const job = await service.createJob({ ...disabledCloudCopy(), enabled: true });
    expect(job.enabled).toBe(true);
    await service.updateJob(job.id, { enabled: false });

    // 模拟另一台 webServer 进程写库（saveCronJob 的整行列形状）：同一任务、停用态、
    // updated_at 更新、名字与排程都改过（指纹必然不同，reconcile 必然重建），
    // 行里带着远端指针。
    dbState.cronRows = [{
      id: job.id,
      name: '另一进程改的名',
      description: null,
      schedule_type: 'every',
      schedule: JSON.stringify({ type: 'every', interval: 2, unit: 'hours' }),
      action: JSON.stringify(disabledCloudCopy().action),
      runs_on: 'cloud',
      max_run_budget: null,
      max_runs: null,
      run_count: 0,
      min_interval_seconds: null,
      result_channel: null,
      cloud_job_id: 'remote-1',
      enabled: 0,
      max_retries: 0,
      retry_delay: null,
      timeout: null,
      tags: null,
      metadata: '{}',
      created_at: job.createdAt,
      updated_at: Date.now() + 5_000,
    }];

    await (service as unknown as { reconcileJobsFromDatabase: () => Promise<void> })
      .reconcileJobsFromDatabase();

    // reconcile 重建后的内存条目仍指向 remote-1（丢指针 = 缺陷本体）。
    const activeAfterReconcile = (service as unknown as {
      jobs: Map<string, { cloudJobId?: string }>;
    }).jobs.get(job.id);
    expect(activeAfterReconcile?.cloudJobId).toBe('remote-1');

    const renamed = await service.updateJob(job.id, { name: '重启后改名' });
    expect(renamed?.name).toBe('重启后改名');
    expect(renamed?.enabled).toBe(false);

    // 全程只注册过一条远端任务：reconcile 重建与后续改名都不许再 add。
    const addCalls = calls.filter((call) => call.path === '/api/cron/add');
    expect(addCalls).toHaveLength(1);

    // 重建后的改名走 remote-1 的 update（不是惰性 add），body 带着 remote-1。
    const updateCalls = calls.filter((call) => call.path === '/api/cron/update');
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    const renameUpdate = updateCalls.find(
      (call) => (call.body?.patch as Record<string, unknown> | undefined)?.name === '重启后改名',
    );
    expect(renameUpdate).toBeTruthy();
    expect(renameUpdate?.body?.id).toBe('remote-1');

    // 最后一次落库的 cron_jobs 行仍指向 remote-1（saveCronJob 第 13 个参数）。
    const jobRows = dbState.savedRows.filter((row) => row[0] === job.id);
    expect(jobRows.length).toBeGreaterThan(0);
    expect(jobRows[jobRows.length - 1]?.[12]).toBe('remote-1');

    // 内存里的活动条目也仍持有 remote-1。
    const active = (service as unknown as {
      jobs: Map<string, { cloudJobId?: string }>;
    }).jobs.get(job.id);
    expect(active?.cloudJobId).toBe('remote-1');

    await service.shutdown();
  });
});

// ============================================================================
// N-ROLE-ROUTINE-RESTATE-FU1-FU1-FU1-FU1-FU1：另一进程创建的启用云端任务
// 只存在 DB 行里；本进程 reconcile 后必须沿用行内远端指针，后续改名只能 update。
// ============================================================================
describe('CronService 跨进程 reconcile 重建启用的云端任务（真实 CronCloudRuntime · 打桩云端网关）', () => {
  it('(f) 空内存从 DB 重建启用任务：保留 remote-1，后续改名只 update 不 add', async () => {
    const calls: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body == null
        ? undefined
        : JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ path, method: init?.method ?? 'GET', body });
      if (path === '/api/cron/add') return fakeOk({ id: 'remote-duplicate' });
      if (path === '/api/cron/update') return fakeOk({});
      if (path === '/api/cron/list') return fakeOk({ jobs: [] });
      throw new Error(`unexpected cloud cron request: ${path}`);
    }));

    const service = new CronService();
    await service.initialize();
    configState.cronCloud = { baseUrl: 'https://cloud.example.test', token: 'test-token' };

    const jobId = 'local-enabled-reconcile-1';
    dbState.cronRows = [{
      id: jobId,
      name: '另一进程创建的启用云端任务',
      description: null,
      schedule_type: 'every',
      schedule: JSON.stringify({ type: 'every', interval: 1, unit: 'hours' }),
      action: JSON.stringify({ type: 'agent', agentType: 'default', prompt: '汇总今天的日程' }),
      runs_on: 'cloud',
      max_run_budget: null,
      max_runs: null,
      run_count: 0,
      min_interval_seconds: null,
      result_channel: null,
      cloud_job_id: 'remote-1',
      enabled: 1,
      max_retries: 0,
      retry_delay: null,
      timeout: null,
      tags: null,
      metadata: '{}',
      created_at: Date.now() - 60_000,
      updated_at: Date.now(),
    }];

    await (service as unknown as { reconcileJobsFromDatabase: () => Promise<void> })
      .reconcileJobsFromDatabase();

    const activeAfterReconcile = (service as unknown as {
      jobs: Map<string, { cloudJobId?: string }>;
    }).jobs.get(jobId);
    expect(activeAfterReconcile?.cloudJobId).toBe('remote-1');

    const renamed = await service.updateJob(jobId, { name: '本进程改名' });
    expect(renamed?.name).toBe('本进程改名');

    const updateCalls = calls.filter((call) => call.path === '/api/cron/update');
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.body?.id).toBe('remote-1');
    expect(calls.filter((call) => call.path === '/api/cron/add')).toHaveLength(0);

    const jobRows = dbState.savedRows.filter((row) => row[0] === jobId);
    expect(jobRows.length).toBeGreaterThan(0);
    expect(jobRows[jobRows.length - 1]?.[12]).toBe('remote-1');

    await service.shutdown();
  });
});
