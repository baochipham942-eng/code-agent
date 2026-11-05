// ============================================================================
// Neo 托管判官（N-JEV-NEO-KEY）客户端路由测试 —— 验收 ③
// ----------------------------------------------------------------------------
// 不 mock typesafeProvider 本体：路由/退避/请求路径都是真实代码，只 mock key 来源
// （providerResolution / configService / authService）与 fetch。覆盖：
// 优先级 official > consented OpenRouter > neo_hosted；OpenRouter key 存在（含未同意）
// 不走托管；未登录 / 总开关关 / neoHostedEnabled 关 → 不托管；限流错误码 → blocked-until
// 映射（用户日限 = 下一个 UTC 日界，熔断 = 30 分钟）且到点前零网络调用；getJevStatus
// 形状（hosted 切片）；托管请求体不带 model、鉴权头用云端 access token。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const keyState = vi.hoisted(() => ({
  typesafe: '' as string,
  openrouter: undefined as string | undefined,
  jev: { enabled: true, openRouterConsent: false, neoHostedEnabled: true } as {
    enabled?: boolean;
    openRouterConsent?: boolean;
    neoHostedEnabled?: boolean;
  },
  user: null as null | { id: string; email: string },
  accessToken: 'cloud-access-token-live' as string | null,
  configThrows: false,
}));

const loggerWarns = vi.hoisted(() => [] as unknown[][]);

vi.mock('../../../src/host/model/providers/providerResolution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/model/providers/providerResolution')>();
  return {
    ...actual,
    resolveProviderApiKey: (config: { provider?: string }) => (
      config?.provider === 'typesafe' ? keyState.typesafe : ''
    ),
  };
});

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getApiKey: (provider: string) => (provider === 'openrouter' ? keyState.openrouter : undefined),
    getSettings: () => {
      if (keyState.configThrows) throw new Error('config service unavailable');
      return { jev: keyState.jev };
    },
  }),
}));

// 与 typesafeProvider 的深路径 import 对齐（services/auth/authService，不走 barrel）。
vi.mock('../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({
    getCurrentUser: () => keyState.user,
    getAccessToken: async () => keyState.accessToken,
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => { loggerWarns.push(args); },
    error: () => {},
  }),
}));

import type { JevRoute } from '../../../src/host/model/providers/typesafeProvider';
import { JEV_HOSTED_FUSE_RETRY_AFTER_MS, JEV_MODEL } from '../../../src/shared/constants/jevQuestions';
import { JEV_HOSTED_TIMEOUTS } from '../../../src/shared/constants/timeouts';
import type { JevQuestionSpec } from '../../../src/shared/constants/jevQuestions';

// 退避状态是模块级单例：每个用例 vi.resetModules() 后重新 import，拿到干净状态
// （不再为测试额外导出 reset 函数——knip 生产导出棘轮不为测试钩子放宽）。
let buildJevDecisionRequestBody: typeof import('../../../src/host/model/providers/jevDecisionRequest').buildJevDecisionRequestBody;
let probeJevHostedEligible: typeof import('../../../src/host/model/providers/typesafeProvider').probeJevHostedEligible;
let probeJevKeySource: typeof import('../../../src/host/model/providers/typesafeProvider').probeJevKeySource;
let resolveJevRoute: typeof import('../../../src/host/model/providers/typesafeProvider').resolveJevRoute;
let systemOne: typeof import('../../../src/host/model/providers/typesafeProvider').systemOne;
let getJevHostedBlock: typeof import('../../../src/host/model/jevHostedQuota').getJevHostedBlock;
let createProductionJevCall: typeof import('../../../src/host/model/jevFeatures').createProductionJevCall;
let getJevStatus: typeof import('../../../src/host/model/jevFeatures').getJevStatus;

const QUESTIONS: Record<string, JevQuestionSpec> = {
  needs_human: { type: 'noul', instructions: 'Does this need a human?' },
};

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  vi.resetModules();
  ({ buildJevDecisionRequestBody } = await import('../../../src/host/model/providers/jevDecisionRequest'));
  ({ probeJevHostedEligible, probeJevKeySource, resolveJevRoute, systemOne } = await import('../../../src/host/model/providers/typesafeProvider'));
  ({ getJevHostedBlock } = await import('../../../src/host/model/jevHostedQuota'));
  ({ createProductionJevCall, getJevStatus } = await import('../../../src/host/model/jevFeatures'));
  keyState.typesafe = '';
  keyState.openrouter = undefined;
  keyState.jev = { enabled: true, openRouterConsent: false, neoHostedEnabled: true };
  keyState.user = { id: 'user-1', email: 'user@example.com' };
  keyState.accessToken = 'cloud-access-token-live';
  keyState.configThrows = false;
  loggerWarns.length = 0;
  vi.useRealTimers();
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('路由优先级：official > consented OpenRouter > neo_hosted', () => {
  it('官方 key 在场：即使已登录也走 official（不读托管）', () => {
    keyState.typesafe = 'official-key-hosted';
    expect(probeJevKeySource()).toBe('official');
    expect(resolveJevRoute()).toMatchObject({ kind: 'official', apiKey: 'official-key-hosted' });
  });

  it('无官方 key、OpenRouter key + 已同意：走 openrouter（不读托管）', () => {
    keyState.openrouter = 'or-key';
    keyState.jev = { enabled: true, openRouterConsent: true };
    expect(probeJevKeySource()).toBe('openrouter');
    expect(resolveJevRoute()).toMatchObject({ kind: 'openrouter', apiKey: 'or-key' });
  });

  it('无官方 key、OpenRouter key 未同意：openrouter_pending_consent，仍不走托管（同意闸门不被 Neo 出钱绕过）', () => {
    keyState.openrouter = 'or-key';
    expect(probeJevKeySource()).toBe('openrouter_pending_consent');
    expect(resolveJevRoute()).toBeNull();
  });

  it('两把 key 都没有 + 已登录 + 两道开关开：neo_hosted，endpoint 是云端计量代理、apiKey 占位空串', () => {
    const route = resolveJevRoute();
    expect(probeJevKeySource()).toBe('neo_hosted');
    expect(route).toMatchObject({ kind: 'neo_hosted', model: JEV_MODEL, apiKey: '' });
    expect((route as JevRoute).endpoint).toContain('/api/v1/jev-judge');
  });
});

describe('托管资格闸门（不满足即回到今日的 none 行为）', () => {
  it('未登录 → none，probeJevHostedEligible false', () => {
    keyState.user = null;
    expect(probeJevKeySource()).toBe('none');
    expect(probeJevHostedEligible()).toBe(false);
    expect(resolveJevRoute()).toBeNull();
  });

  it('总开关关 → disabled_by_user（即使已登录无 key）', () => {
    keyState.jev = { enabled: false };
    expect(probeJevKeySource()).toBe('disabled_by_user');
    expect(probeJevHostedEligible()).toBe(false);
  });

  it('neoHostedEnabled 关 → none，但资格探针仍 true（设置页保留子开关行）', () => {
    keyState.jev = { enabled: true, neoHostedEnabled: false };
    expect(probeJevKeySource()).toBe('none');
    expect(resolveJevRoute()).toBeNull();
    expect(probeJevHostedEligible()).toBe(true);
  });

  it('未登录时状态快照不出现 hosted 切片（keySource none）', () => {
    keyState.user = null;
    const status = getJevStatus();
    expect(status.keySource).toBe('none');
    expect(status.hosted).toBeUndefined();
  });

  it('configService 抛错（CLI/测试骨架）→ 按缺省（总开关开/云判官开）处理，已登录仍可托管', () => {
    keyState.configThrows = true;
    expect(probeJevKeySource()).toBe('neo_hosted');
  });
});

describe('限流错误码 → blocked-until 映射', () => {
  it('jev_user_daily_limit → 退避到下一个 UTC 日界；期间 resolveJevRoute null、零 fetch', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ error: 'jev_user_daily_limit', message: 'used up' }),
      { status: 429 },
    ));

    const answers = await systemOne({ command: 'x' }, QUESTIONS, {}).catch((error: Error & { code?: string }) => error);
    expect((answers as Error & { code?: string }).code).toBe('JEV_HOSTED_USER_LIMIT');

    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const nextUtcDayStart = Math.floor(now / dayMs) * dayMs + dayMs;
    const block = getJevHostedBlock(now);
    expect(block?.blockReason).toBe('user_daily_limit');
    expect(block?.blockedUntil).toBe(nextUtcDayStart);
    expect(block!.blockedUntil).toBeGreaterThan(now);

    // 退避期内：路由不可用（视同无 key），不再发请求。
    expect(resolveJevRoute()).toBeNull();
    const call = createProductionJevCall('permissionClassifier');
    await expect(call({ command: 'x' }, QUESTIONS, {})).rejects.toMatchObject({ code: 'TYPESAFE_KEY_MISSING' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 留痕：blockJevHosted 的 warn 每原因一条（[jev-hosted] 前缀），可区分到「额度用完」。
    const blockWarns = loggerWarns.filter((args) => String(args[0]).includes('[jev-hosted]'));
    expect(blockWarns).toHaveLength(1);
    expect(String(blockWarns[0][0])).toContain('额度已用完');
    const degradeWarn = loggerWarns.find((args) => String(args[0]).includes('CODE_AGENT_PERMISSION_LLM_CLASSIFIER'));
    expect(String(degradeWarn?.[0])).toContain('限流退避');
  });

  it('jev_global_fuse → 退避 30 分钟（JEV_HOSTED_FUSE_RETRY_AFTER_MS）', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(new Response(
      JSON.stringify({ error: 'jev_global_fuse', message: 'fuse' }),
      { status: 503 },
    ));
    const before = Date.now();
    const error = await systemOne({ command: 'x' }, QUESTIONS, {}).catch((e: Error & { code?: string }) => e);
    const now = Date.now();
    expect(error.code).toBe('JEV_HOSTED_GLOBAL_FUSE');
    const block = getJevHostedBlock(now);
    expect(block?.blockReason).toBe('global_fuse');
    // 退避起点是调用途中的时刻，不能和调用后再取的 now 比到毫秒
    expect(block!.blockedUntil).toBeGreaterThanOrEqual(before + JEV_HOSTED_FUSE_RETRY_AFTER_MS);
    expect(block!.blockedUntil).toBeLessThanOrEqual(now + JEV_HOSTED_FUSE_RETRY_AFTER_MS);
    const fuseWarns = loggerWarns.filter((args) => String(args[0]).includes('全局熔断'));
    expect(fuseWarns).toHaveLength(1);
  });

  it('退避到点后自动恢复托管路由', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T12:00:00Z').getTime());
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ error: 'jev_global_fuse', message: 'fuse' }),
      { status: 503 },
    ));
    await systemOne({ command: 'x' }, QUESTIONS, {}).catch(() => undefined);
    expect(resolveJevRoute()).toBeNull();
    // 时间越过 blockedUntil：退避自动解除（无需显式清除）。
    vi.setSystemTime(new Date('2026-10-25T12:00:00Z').getTime() + JEV_HOSTED_FUSE_RETRY_AFTER_MS + 1);
    expect(getJevHostedBlock()).toBeNull();
    expect(resolveJevRoute()).toMatchObject({ kind: 'neo_hosted' });
  });
});

describe('托管请求路径（真实 systemOne）', () => {
  it('ok：Bearer 云端 access token、请求体只有 state/questions（无 model），answers 返回', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ answers: { needs_human: { noul: 0.1 } } }),
      { status: 200 },
    ));
    const answers = await systemOne({ command: 'npm view left-pad version' }, QUESTIONS, {});
    expect(answers).toEqual({ needs_human: { noul: 0.1 } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/jev-judge');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer cloud-access-token-live');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('model');
    expect(body.state).toEqual({ command: 'npm view left-pad version' });
    expect(body.questions).toEqual(QUESTIONS);
  });

  it('拿不到 access token → JEV_HOSTED_AUTH_TOKEN_MISSING，零 fetch，warn 一条', async () => {
    keyState.accessToken = null;
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const error = await systemOne({ command: 'x' }, QUESTIONS, {}).catch((e: Error & { code?: string }) => e);
    expect(error.code).toBe('JEV_HOSTED_AUTH_TOKEN_MISSING');
    expect(fetchMock).not.toHaveBeenCalled();
    const warns = loggerWarns.filter((args) => String(args[0]).includes('云端 access token'));
    expect(warns).toHaveLength(1);
  });

  it('buildJevDecisionRequestBody：托管不带 model，official 带', () => {
    const hosted = buildJevDecisionRequestBody(
      { kind: 'neo_hosted', endpoint: 'https://cloud/api/v1/jev-judge', model: JEV_MODEL, apiKey: '' },
      { a: 1 },
      QUESTIONS,
    );
    expect(hosted).not.toHaveProperty('model');
    const official = buildJevDecisionRequestBody(
      { kind: 'official', endpoint: 'https://api.typesafe.ai/v1/systemone', model: JEV_MODEL, apiKey: 'k' },
      { a: 1 },
      QUESTIONS,
    );
    expect(official).toHaveProperty('model', JEV_MODEL);
  });
});

describe('getJevStatus：托管切片', () => {
  it('托管可用：keyConfigured=true、route=neo_hosted、hosted={eligible,未退避}、特性 effective', () => {
    const status = getJevStatus();
    expect(status.keySource).toBe('neo_hosted');
    expect(status.keyConfigured).toBe(true);
    expect(status.route).toBe('neo_hosted');
    expect(status.hosted).toEqual({ eligible: true, blockedUntil: null, blockReason: null });
    expect(status.features.permissionClassifier.effective).toBe(true);
  });

  it('托管退避中：keyConfigured=false、route=null、hosted.blockedUntil 有值、特性降级', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(new Response(
      JSON.stringify({ error: 'jev_user_daily_limit', message: 'used up' }),
      { status: 429 },
    ));
    await systemOne({ command: 'x' }, QUESTIONS, {}).catch(() => undefined);
    const status = getJevStatus();
    expect(status.keySource).toBe('neo_hosted');
    expect(status.keyConfigured).toBe(false);
    expect(status.route).toBeNull();
    expect(status.hosted?.eligible).toBe(true);
    expect(status.hosted?.blockReason).toBe('user_daily_limit');
    expect(typeof status.hosted?.blockedUntil).toBe('number');
    expect(status.features.router.effective).toBe(false);
  });
});

// ai-review Important（PR #2704）：持续性服务故障也必须退避，否则云端漏配时每次判官调用
// 都先付一次最长 JEV_TIMEOUT_MS 的云端往返才降级（基线对这类用户是零网络即时降级）。
describe('持续性服务故障 → 短退避（service_unavailable）', () => {
  const FAILURES: Array<{ name: string; response: () => Response }> = [
    { name: '401 jev_auth_required',
      response: () => new Response(JSON.stringify({ error: 'jev_auth_required' }), { status: 401 }) },
    { name: '503 jev_counter_unavailable', response: () => new Response(JSON.stringify({ error: 'jev_counter_unavailable' }), { status: 503 }) },
    { name: '503 jev_upstream_unconfigured', response: () => new Response(JSON.stringify({ error: 'jev_upstream_unconfigured' }), { status: 503 }) },
    { name: '502 jev_upstream_error', response: () => new Response(JSON.stringify({ error: 'jev_upstream_error' }), { status: 502 }) },
    { name: '404 未部署（非 JSON 体）', response: () => new Response('Not Found', { status: 404 }) },
  ];

  for (const failure of FAILURES) {
    it(`${failure.name} → 进入 service_unavailable 退避；之后 resolveJevRoute null、零 fetch、状态可见`, async () => {
      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      fetchMock.mockImplementation(async () => failure.response());
      const error = await systemOne({ command: 'x' }, QUESTIONS, {}).catch((e: Error & { code?: string }) => e);
      expect(error).toBeInstanceOf(Error);

      const now = Date.now();
      const block = getJevHostedBlock(now);
      expect(block?.blockReason).toBe('service_unavailable');
      expect(block!.blockedUntil).toBeGreaterThan(now);
      expect(block!.blockedUntil).toBeLessThanOrEqual(now + JEV_HOSTED_TIMEOUTS.SERVICE_FAILURE_BACKOFF);

      expect(resolveJevRoute()).toBeNull();
      const call = createProductionJevCall('permissionClassifier');
      await expect(call({ command: 'x' }, QUESTIONS, {})).rejects.toMatchObject({ code: 'TYPESAFE_KEY_MISSING' });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const status = getJevStatus();
      expect(status.keyConfigured).toBe(false);
      expect(status.hosted?.blockReason).toBe('service_unavailable');
      expect(loggerWarns.filter((args) => String(args[0]).includes('[jev-hosted]'))).toHaveLength(1);
    });
  }

  it('401 保留可区分的 JEV_HOSTED_AUTH_REQUIRED 错误码', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ error: 'jev_auth_required' }), { status: 401 }),
    );
    const error = await systemOne({ command: 'x' }, QUESTIONS, {}).catch((e: Error & { code?: string }) => e);
    expect((error as Error & { code?: string }).code).toBe('JEV_HOSTED_AUTH_REQUIRED');
  });

  it('网络失败（fetch reject）→ 同样退避', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await systemOne({ command: 'x' }, QUESTIONS, {}).catch(() => undefined);
    expect(getJevHostedBlock()?.blockReason).toBe('service_unavailable');
    expect(resolveJevRoute()).toBeNull();
  });

  it('请求超时 → 同样退避；调用方主动取消（外部 signal）不算服务故障、不退避', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    await systemOne({ command: 'x' }, QUESTIONS, { timeoutMs: 20 }).catch(() => undefined);
    expect(getJevHostedBlock()?.blockReason).toBe('service_unavailable');

    // 外部取消：换一份干净状态再测。
    vi.resetModules();
    ({ systemOne } = await import('../../../src/host/model/providers/typesafeProvider'));
    ({ getJevHostedBlock } = await import('../../../src/host/model/jevHostedQuota'));
    const controller = new AbortController();
    const pending = systemOne({ command: 'x' }, QUESTIONS, { signal: controller.signal, timeoutMs: 5000 }).catch(() => undefined);
    setTimeout(() => controller.abort(), 10);
    await pending;
    expect(getJevHostedBlock()).toBeNull();
  });

  it('请求级 4xx（400 坏请求）不退避：不是服务故障', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ error: 'jev_bad_request' }), { status: 400 }),
    );
    await systemOne({ command: 'x' }, QUESTIONS, {}).catch(() => undefined);
    expect(getJevHostedBlock()).toBeNull();
  });

  it('退避时长到点自动恢复（SERVICE_FAILURE_BACKOFF 后路由回来）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T12:00:00Z').getTime());
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(new Response('Not Found', { status: 404 }));
    await systemOne({ command: 'x' }, QUESTIONS, {}).catch(() => undefined);
    expect(resolveJevRoute()).toBeNull();
    vi.setSystemTime(new Date('2026-11-03T12:00:00Z').getTime() + JEV_HOSTED_TIMEOUTS.SERVICE_FAILURE_BACKOFF + 1);
    expect(resolveJevRoute()).toMatchObject({ kind: 'neo_hosted' });
  });
});
