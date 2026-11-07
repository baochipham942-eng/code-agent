// ============================================================================
// N-CRON-WEBHOOK-CLOUD-HOOK-FU1 —— 真 CronService + 真 IPC handler + 打桩云端网关
// （fetch 桩讲 wire 文档的 {ok,result} 信封，hook 端点带令牌有效性账本）。
// ② 建 webhook 任务 -> register 恰好一次 -> 链接只在返回值里出现一次；落库行、任务表
//    JSON、控制台输出都不含 hook 令牌与云端令牌（沿用 cronWebhookRelay.test ⑥ 的捕获法）。
// ③ 重新生成走 rotate、旧链接失效；云端未配置给可区分错误码（渲染层据此本地化）。
// ④ 保存云端配置后经 ensureCloudStream 启动事件流：免重启、恰好一次（幂等）。
// ⑤（N-CRON-WEBHOOK-CLOUD-HOOK-FU1-FU1-CONTRACT）钉死 relay 线协议契约：停用（真 remove
//    路径）后 rotate 同 register 发全新对、旧 token 不复活；create -> register -> disable
//    -> enable -> rotate 全路径重新启用不 mint；新旧 URL/token 不落库不进任务表不进控制台；
//    他账号 Bearer 的 403 以带 HTTP 状态的可区分错误浮出，不是静默成功。
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
type GatewayInit = { body?: unknown; headers?: Record<string, string> };
let gatewayFetch: (input: unknown, init?: GatewayInit) => Promise<unknown> = async () => {
  throw new Error('gateway not installed');
};
vi.stubGlobal('fetch', (input: unknown, init?: GatewayInit) => gatewayFetch(input, init));

/**
 * 云端网关桩（N-CRON-WEBHOOK-CLOUD-HOOK-FU1-FU1-CONTRACT）：按 jobId 记账的令牌账本，
 * 按 wire 契约执行——(a) rotate 对未注册/已 remove 的 jobId 同 register（发全新对）；
 * (b) 某 jobId 发过的旧 token 吊销后永不复活；(c) jobId 归首次 register 它的 Bearer
 * 账号所有，他账号的 register/rotate/remove 一律 403 且错误体同形（不泄露存在性）。
 * isUrlValid 走投递入口的判定口径：当前 token 命中 = 200；jobId 在账但 token 错 = 401；
 * jobId 未知/已 remove = 404。
 */
function installGateway() {
  const counts = { register: 0, rotate: 0, remove: 0, events: 0 };
  /** jobId -> 当前有效 token；remove 即删条目，rotate 对已 remove 的 jobId 重建条目。 */
  const activeTokens = new Map<string, string>();
  /** jobId -> 属主账号（首次 register 时的 Authorization 头原值）。 */
  const ownerByJob = new Map<string, string>();
  let issued = 0;
  const urlFor = (jobId: string, token: string) => `https://relay.example.test/api/cron/hooks/${jobId}?token=${token}`;
  const ok = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
  // 契约 c：错误体对他账号保持同一形状，不含 jobId、不含存在性信号
  const forbidden = () => ({ ok: false, status: 403, json: async () => ({ ok: false, error: 'forbidden' }) });

  gatewayFetch = vi.fn(async (input: unknown, init?: GatewayInit) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body == null ? {} : JSON.parse(String(init.body)) as { jobId?: string };
    if (path === '/api/cron/events') {
      counts.events += 1;
      // 长驻 SSE：永不产出也永不结束
      return { ok: true, status: 200, body: { getReader: () => ({ read: () => new Promise(() => {}), releaseLock: () => {} }) } };
    }
    if (path === '/api/cron/runs' || path === '/api/cron/list') return ok({ runs: [], jobs: [] });
    if (path === '/api/cron/hooks/register' || path === '/api/cron/hooks/rotate' || path === '/api/cron/hooks/remove') {
      const jobId = String(body.jobId);
      const account = init?.headers?.Authorization ?? '';
      const owner = ownerByJob.get(jobId);
      if (owner !== undefined && owner !== account) return forbidden(); // 契约 c：非属主 403
      if (path === '/api/cron/hooks/remove') {
        counts.remove += 1;
        activeTokens.delete(jobId); // 幂等：未注册的 jobId 也回 2xx
        return ok({});
      }
      const operation = path.endsWith('register') ? 'register' : 'rotate';
      counts[operation] += 1;
      const token = [HOOK_TOKEN_1, HOOK_TOKEN_2][issued] ?? `hk_extra_${issued}`;
      issued += 1;
      if (owner === undefined) ownerByJob.set(jobId, account);
      // 契约 a：rotate 对未知/已 remove 的 jobId 同 register——（重新）建条目发全新对；
      // 契约 b：旧 token 只被动失效（不在当前条目里），不回显、不复活。
      activeTokens.set(jobId, token);
      return ok({ url: urlFor(jobId, token), token });
    }
    throw new Error(`unexpected cloud request: ${path}`);
  });

  const deliverStatus = (url: string) => {
    const jobId = new URL(url).pathname.split('/').pop() ?? '';
    return activeTokens.has(jobId)
      ? (activeTokens.get(jobId) === new URL(url).searchParams.get('token') ? 200 : 401)
      : 404;
  };

  return {
    counts,
    isUrlValid: (url: string) => deliverStatus(url) === 200,
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

  it('⑤ 停用（真 remove 路径）后 rotate：同 register 发全新对；旧 URL 失效（401/404）、新 URL 有效', async () => {
    configureCloud();
    const gateway = installGateway();
    const job = await service.createJob(webhookInput());
    const first = (await callIpc('registerWebhookHook', { jobId: job.id })).data as { url: string; token: string };
    expect(gateway.isUrlValid(first.url)).toBe(true);

    // 停用走真 disable 路径：updateJob(enabled:false) 触发 fire-and-forget 的 removeHookForJob
    await callIpc('updateJob', { jobId: job.id, updates: { enabled: false } });
    await vi.waitFor(() => expect(gateway.counts.remove).toBe(1));
    expect(gateway.isUrlValid(first.url)).toBe(false); // remove 即吊销（jobId 已不在账上 -> 404）

    const response = await callIpc('rotateWebhookHook', { jobId: job.id });
    expect(response).toMatchObject({ success: true });
    const second = response.data as { url: string; token: string };
    expect(gateway.counts.rotate).toBe(1);
    expect(gateway.counts.register).toBe(1); // rotate 对已 remove 的 jobId 不走 register 端点
    expect(gateway.isUrlValid(first.url)).toBe(false); // 契约 b：旧 URL/旧 token 不复活
    expect(second.token).not.toBe(first.token);
    expect(gateway.isUrlValid(second.url)).toBe(true);
  });

  it('⑤ 全路径 create -> register -> disable -> enable -> rotate：重新启用不 mint，重新生成发新对', async () => {
    configureCloud();
    const gateway = installGateway();
    const job = await service.createJob(webhookInput());
    const first = (await callIpc('registerWebhookHook', { jobId: job.id })).data as { url: string };

    await callIpc('updateJob', { jobId: job.id, updates: { enabled: false } });
    await vi.waitFor(() => expect(gateway.counts.remove).toBe(1));

    await callIpc('updateJob', { jobId: job.id, updates: { enabled: true } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gateway.counts.register).toBe(1); // 重新启用不自动 mint
    expect(gateway.counts.rotate).toBe(0);
    expect(gateway.isUrlValid(first.url)).toBe(false); // 旧链接仍是吊销态

    const second = (await callIpc('rotateWebhookHook', { jobId: job.id })).data as { url: string };
    expect(second.url).toContain(HOOK_TOKEN_2);
    expect(gateway.isUrlValid(first.url)).toBe(false);
    expect(gateway.isUrlValid(second.url)).toBe(true);
  });

  it('⑤ 停用 -> 重新生成全链路：新旧 URL/token 都不落库、不进任务表、不进控制台', async () => {
    configureCloud();
    const gateway = installGateway();
    const spies = ['error', 'warn', 'log', 'info']
      .map((name) => vi.spyOn(console, name as 'error').mockImplementation(() => {}));
    let consoleOutput: string;
    let jobId: string;
    try {
      const job = await service.createJob(webhookInput());
      jobId = job.id;
      await callIpc('registerWebhookHook', { jobId });
      await callIpc('updateJob', { jobId, updates: { enabled: false } });
      await vi.waitFor(() => expect(gateway.counts.remove).toBe(1));
      const second = (await callIpc('rotateWebhookHook', { jobId })).data as { url: string };
      expect(gateway.isUrlValid(second.url)).toBe(true); // 走到这一步链路才算完整
      console.error('[capture-sentinel] benign noise during disable -> regenerate');
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
      expect(haystack).not.toContain(HOOK_TOKEN_1); // 旧 token
      expect(haystack).not.toContain(HOOK_TOKEN_2); // 新 token
      expect(haystack).not.toContain(CLOUD_TOKEN);
      expect(haystack).not.toContain('relay.example.test'); // 整个 hook URL 都不出现
    }
  });

  it('⑤ 他账号 Bearer 的 403：rotate 回带 HTTP 状态的可区分错误，不是静默成功', async () => {
    configureCloud();
    const gateway = installGateway();
    const job = await service.createJob(webhookInput());
    await callIpc('registerWebhookHook', { jobId: job.id }); // 属主 = 默认云端账号
    // 换成另一个账号的 Bearer：对非属主 jobId，网关按契约 c 回 403
    configState.keys['neo-cron-cloud'] = 'cloud-token-other-account';

    const response = await callIpc('rotateWebhookHook', { jobId: job.id });
    expect(response).toMatchObject({ success: false, error: { code: 'CRON_ERROR' } });
    const message = ((response as { error?: { message?: string } }).error ?? {}).message ?? '';
    expect(message).toContain('Cloud cron hook rotate failed');
    expect(message).toContain('(HTTP 403)');
    expect(gateway.counts.rotate).toBe(0); // 网关侧真的拒了，没有 mint
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
