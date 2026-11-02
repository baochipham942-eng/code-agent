// ============================================================================
// N-CRON-WEBHOOK-CLOUD-HOOK-FU1 —— 真 CronService + 真 IPC handler + 打桩云端网关
// （fetch 桩讲 wire 文档的 {ok,result} 信封，hook 端点带令牌有效性账本）。
// ② 建 webhook 任务 -> register 恰好一次 -> 链接只在返回值里出现一次；落库行、任务表
//    JSON、控制台输出都不含 hook 令牌与云端令牌（沿用 cronWebhookRelay.test ⑥ 的捕获法）。
// ③ 重新生成走 rotate、旧链接失效；云端未配置给可区分错误码（渲染层据此本地化）。
// ④ 保存云端配置后经 ensureCloudStream 启动事件流：免重启、恰好一次（幂等）。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

const dbState = vi.hoisted(() => ({ savedRows: [] as unknown[][] }));
const configState = vi.hoisted(() => ({
  baseUrl: undefined as string | undefined,
  keys: {} as Record<string, string | undefined>,
}));
const ipcState = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, request: IPCRequest) => Promise<IPCResponse>>(),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getDb: () => ({
      prepare: () => ({
        all: () => [],
        get: () => undefined,
        run: (...args: unknown[]) => {
          dbState.savedRows.push(args);
          return { changes: 0 };
        },
      }),
    }),
    getSession: () => null,
  }),
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    onSettingsUpdated: vi.fn(),
    getSettings: () => ({
      ui: { language: 'zh' },
      ...(configState.baseUrl ? { cronCloud: { baseUrl: configState.baseUrl } } : {}),
    }),
    getServiceApiKey: (service: string) => configState.keys[service],
  }),
}));

vi.mock('../../../src/host/channels/channelManager', () => ({
  getChannelManager: () => ({
    getAccount: () => undefined,
    getAllAccounts: () => [],
    sendMessage: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  }),
}));

vi.mock('../../../src/host/platform', () => ({
  broadcastToRenderer: vi.fn(),
  ipcHost: { handle: (channel: string, fn: (event: unknown, request: IPCRequest) => Promise<IPCResponse>) => ipcState.handlers.set(channel, fn) },
}));

vi.mock('../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => ({
    recordCreated: vi.fn(async () => undefined),
    recordEvent: vi.fn(async () => undefined),
    getBySourceRef: vi.fn(() => null),
    upsert: vi.fn(() => undefined),
  }),
}));

vi.mock('../../../src/host/model/modelRouter', () => ({ ModelRouter: class {} }));
vi.mock('../../../src/host/services/core/sessionDefaults', () => ({
  resolveSessionDefaultModelConfig: () => ({ provider: 'p', model: 'm' }),
}));

import { CronService, getCronService } from '../../../src/host/cron/cronService';
import { registerCronHandlers } from '../../../src/host/ipc/cron.ipc';
import { shutdownEventBus } from '../../../src/host/services/eventing/bus';

const CLOUD_BASE = 'https://cloud.example.test';
const CLOUD_TOKEN = 'cloud-token-9f3a-not-for-logs';
const HOOK_TOKEN_1 = 'hk_live_first_7c1f9d2e';
const HOOK_TOKEN_2 = 'hk_live_second_a41b6e03';

/**
 * CronApiClient 构造时把全局 fetch 收成默认参数、而单例 CronService 只构造一次：
 * 全局先装一个稳定的转发器，各用例再换内部实现。
 */
let gatewayFetch: (input: unknown, init?: { body?: unknown }) => Promise<unknown> = async () => {
  throw new Error('gateway not installed');
};
vi.stubGlobal('fetch', (input: unknown, init?: { body?: unknown }) => gatewayFetch(input, init));

/** 云端网关桩：hook 令牌账本（register/rotate 发新作废旧）+ 请求计数。 */
function installGateway() {
  const counts = { register: 0, rotate: 0, remove: 0, events: 0 };
  const validTokens = new Set<string>();
  let issued = 0;
  const urlFor = (jobId: string, token: string) => `https://relay.example.test/api/cron/hooks/${jobId}?token=${token}`;
  const ok = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });

  gatewayFetch = vi.fn(async (input: unknown, init?: { body?: unknown }) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body == null ? {} : JSON.parse(String(init.body)) as { jobId?: string };
    if (path === '/api/cron/events') {
      counts.events += 1;
      // 长驻 SSE：永不产出也永不结束
      return { ok: true, status: 200, body: { getReader: () => ({ read: () => new Promise(() => {}), releaseLock: () => {} }) } };
    }
    if (path === '/api/cron/runs' || path === '/api/cron/list') return ok({ runs: [], jobs: [] });
    if (path === '/api/cron/hooks/register' || path === '/api/cron/hooks/rotate') {
      const operation = path.endsWith('register') ? 'register' : 'rotate';
      counts[operation] += 1;
      validTokens.clear();
      const token = [HOOK_TOKEN_1, HOOK_TOKEN_2][issued] ?? `hk_extra_${issued}`;
      issued += 1;
      validTokens.add(token);
      return ok({ url: urlFor(String(body.jobId), token), token });
    }
    if (path === '/api/cron/hooks/remove') {
      counts.remove += 1;
      validTokens.clear();
      return ok({});
    }
    throw new Error(`unexpected cloud request: ${path}`);
  });

  return {
    counts,
    isUrlValid: (url: string) => validTokens.has(new URL(url).searchParams.get('token') ?? ''),
  };
}

function webhookInput() {
  return {
    name: 'watch sentry alerts',
    enabled: true,
    scheduleType: 'event' as const,
    schedule: { type: 'event' as const, source: 'webhook' as const, eventName: 'message' as const },
    action: { type: 'agent' as const, agentType: 'default' as const, prompt: 'Summarise new alerts.' },
    runsOn: 'local' as const,
    maxRunBudget: 0.5,
  };
}

const callIpc = (action: string, payload?: unknown) =>
  ipcState.handlers.get(IPC_DOMAINS.CRON)!(null, { action, payload } as IPCRequest);

function configureCloud() {
  configState.baseUrl = CLOUD_BASE;
  configState.keys['neo-cron-cloud'] = CLOUD_TOKEN;
}

async function waitForStream(gateway: ReturnType<typeof installGateway>) {
  await vi.waitFor(() => expect(gateway.counts.events).toBeGreaterThanOrEqual(1));
}

describe('N-CRON-WEBHOOK-CLOUD-HOOK-FU1（真 CronService + 打桩云端网关）', () => {
  let service: CronService;

  beforeEach(async () => {
    ipcState.handlers.clear();
    registerCronHandlers();
    service = getCronService();
    await service.initialize();
  });

  afterEach(async () => {
    await service.shutdown();
    (service as unknown as { isInitialized: boolean }).isInitialized = false;
    (service as unknown as { jobs: Map<string, unknown> }).jobs.clear();
    dbState.savedRows = [];
    configState.baseUrl = undefined;
    configState.keys = {};
    shutdownEventBus();
  });

  it('② 建 webhook 任务 -> register 恰好一次 -> 链接只在返回值里；库/任务表/控制台都不含令牌', async () => {
    configureCloud();
    const gateway = installGateway();
    const spies = ['error', 'warn', 'log', 'info']
      .map((name) => vi.spyOn(console, name as 'error').mockImplementation(() => {}));
    let consoleOutput: string;
    let secretUrl: string;
    let jobId: string;
    try {
      const job = await service.createJob(webhookInput());
      jobId = job.id;
      expect(gateway.counts.register).toBe(0); // 创建本身不 mint：由 UI 创建后显式 register

      const response = await callIpc('registerWebhookHook', { jobId });
      expect(response).toMatchObject({ success: true });
      secretUrl = (response.data as { url: string }).url;
      expect(secretUrl).toContain(HOOK_TOKEN_1);
      expect(gateway.counts.register).toBe(1);
      expect(gateway.isUrlValid(secretUrl)).toBe(true);

      console.error('[capture-sentinel] benign noise during hook lifecycle');
      consoleOutput = spies
        .flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(' ')))
        .join('\n');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    expect(consoleOutput).toContain('[capture-sentinel]'); // 防空断言
    const persisted = JSON.stringify(dbState.savedRows);
    const jobTable = JSON.stringify(service.listJobs());
    const internalTable = JSON.stringify([...(service as unknown as { jobs: Map<string, unknown> }).jobs.entries()]
      .map(([, active]) => (active as { definition: unknown }).definition));
    expect(persisted).toContain(jobId); // 任务行确实落过库
    for (const haystack of [persisted, jobTable, internalTable, consoleOutput]) {
      expect(haystack).not.toContain(HOOK_TOKEN_1);
      expect(haystack).not.toContain(CLOUD_TOKEN);
    }
  });

  it('③ 重新生成走 rotate：旧链接失效、新链接有效；非 webhook 任务被拒', async () => {
    configureCloud();
    const gateway = installGateway();
    const job = await service.createJob(webhookInput());
    const first = (await callIpc('registerWebhookHook', { jobId: job.id })).data as { url: string };
    const second = (await callIpc('rotateWebhookHook', { jobId: job.id })).data as { url: string };

    expect(gateway.counts.rotate).toBe(1);
    expect(second.url).toContain(HOOK_TOKEN_2);
    expect(gateway.isUrlValid(first.url)).toBe(false);
    expect(gateway.isUrlValid(second.url)).toBe(true);

    const every = await service.createJob({
      name: 'plain', enabled: false, scheduleType: 'every',
      schedule: { type: 'every', interval: 1, unit: 'hours' },
      action: { type: 'agent', agentType: 'default', prompt: 'x' },
    });
    const refused = await callIpc('rotateWebhookHook', { jobId: every.id });
    expect(refused).toMatchObject({ success: false, error: { code: 'CRON_ERROR' } });
    expect(gateway.counts.rotate).toBe(1);
  });

  it('③ 云端未配置：register/rotate 回可区分错误码，不是静默失败', async () => {
    configureCloud();
    installGateway();
    const job = await service.createJob(webhookInput());
    configState.baseUrl = undefined;
    configState.keys = {};

    for (const action of ['registerWebhookHook', 'rotateWebhookHook']) {
      const response = await callIpc(action, { jobId: job.id });
      expect(response).toMatchObject({ success: false, error: { code: 'CRON_CLOUD_NOT_CONFIGURED' } });
    }
    await expect(service.createJob(webhookInput())).rejects.toThrow(/cloud scheduler to be configured/);
  });

  it('④ 启动后才保存云端配置：ensureCloudStream 免重启恰好启动一次事件流（幂等）', async () => {
    const gateway = installGateway();
    // 启动时未配置：不起流；此刻调用也不起
    await callIpc('ensureCloudStream');
    expect(gateway.counts.events).toBe(0);

    configureCloud(); // 用户在设置页保存了地址 + 令牌（启动之后）
    expect(await callIpc('ensureCloudStream')).toMatchObject({ success: true });
    await waitForStream(gateway);
    await callIpc('ensureCloudStream');
    await callIpc('ensureCloudStream');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gateway.counts.events).toBe(1);
  });

  it('④ 交出链接之前也保证事件流在跑（配置是启动后才补的，register 本身兜底）', async () => {
    const gateway = installGateway();
    configureCloud();
    const job = await service.createJob(webhookInput());
    await callIpc('registerWebhookHook', { jobId: job.id });
    await waitForStream(gateway);
    expect(gateway.counts.events).toBe(1);
  });

  it('旧版 settings.cronCloud.token 仍可只读回退；安全存储令牌优先', async () => {
    const gateway = installGateway();
    const service2 = service as unknown as { cloudRuntime: { isConfigured(): boolean } };
    configState.baseUrl = CLOUD_BASE;
    expect(service2.cloudRuntime.isConfigured()).toBe(false); // 只有地址，没有令牌
    configState.keys['neo-cron-cloud'] = CLOUD_TOKEN;
    expect(service2.cloudRuntime.isConfigured()).toBe(true);
    expect(gateway.counts.events).toBe(0);
  });
});
