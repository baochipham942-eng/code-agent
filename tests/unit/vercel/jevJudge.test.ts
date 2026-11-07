// ============================================================================
// Jev 托管判官（N-JEV-NEO-KEY）服务端 handler 测试 —— 验收 ① + ③（store/resolver）
// ----------------------------------------------------------------------------
// 内存 store + stub 上游，不触网。覆盖：鉴权（token map / Supabase stub）、ok 路径、
// 500/501 分界与跨用户隔离、全局熔断、计数器故障 fail-closed（绝不打上游）、413、
// 模型服务端 pin、响应与日志永不携带 key、常量与客户端 JEV_MODEL 对齐。
// 反向变异靶子：handler 里的 per-user 限额检查（验收 ⑥）。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_JEV_JUDGE_INPUT_USD_PER_MTOK,
  DEFAULT_JEV_JUDGE_MODEL,
  estimateJevJudgeCallUsd,
  handleJevJudgeRequest,
} from '../../../vercel-api/lib/jevJudge';
import { createInMemoryJevJudgeUsageStore, type JevJudgeUsageStore } from '../../../vercel-api/lib/jevJudgeUsageStore';
import { resolveControlPlaneSubject } from '../../../vercel-api/lib/controlPlaneEntitlements';
import type { ControlPlaneRequestLike, ControlPlaneResponseLike } from '../../../vercel-api/lib/controlPlaneEnvelope';
import { JEV_MODEL } from '../../../src/shared/constants/jevQuestions';

const TYPESAFE_KEY = 'sk-typesafe-live-secret-never-leak';

const TOKEN_A = 'token-user-a';
const TOKEN_B = 'token-user-b';
const TOKEN_MAP = JSON.stringify({
  [TOKEN_A]: {
    subject: { id: 'user-a', email: 'a@example.com' },
    entitlement: { plan: 'pro', capabilities: ['*'], status: 'active' },
  },
  [TOKEN_B]: {
    subject: { id: 'user-b', email: 'b@example.com' },
    entitlement: { plan: 'pro', capabilities: ['*'], status: 'active' },
  },
});

interface CapturedUpstreamCall {
  url: string;
  authorization: string;
  body: { state: unknown; model?: unknown; questions: unknown };
}

function makeEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    CONTROL_PLANE_ENTITLEMENT_TOKEN_MAP_JSON: TOKEN_MAP,
    TYPESAFE_API_KEY: TYPESAFE_KEY,
    ...overrides,
  };
}

function makeResponse(): ControlPlaneResponseLike & { statusCode: number; body: unknown } {
  return {
    statusCode: 200,
    body: undefined,
    setHeader() {},
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(value: unknown) {
      this.body = value;
    },
    end() {},
  } as ControlPlaneResponseLike & { statusCode: number; body: unknown };
}

function makeRequest(token: string | null, body: unknown): ControlPlaneRequestLike {
  return {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body,
  };
}

const ANSWERS = { needs_human: { noul: 0.2 } };

function makeUpstreamFetch(calls: CapturedUpstreamCall[], respond?: () => Response): typeof fetch {
  return vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      authorization: String((init?.headers as Record<string, string>)?.Authorization ?? ''),
      body: JSON.parse(String(init?.body)) as CapturedUpstreamCall['body'],
    });
    return respond?.() ?? new Response(JSON.stringify({ answers: ANSWERS }), { status: 200 });
  }) as unknown as typeof fetch;
}

const GOOD_BODY = { state: { command: 'npm view left-pad version' }, questions: { needs_human: { type: 'noul', instructions: 'x' } } };

async function callHandler(
  env: NodeJS.ProcessEnv,
  options: {
    token?: string | null;
    body?: unknown;
    fetchImpl?: typeof fetch;
    /** 缺省注入一次性内存 store；null = 强制无计数器；'env' = 让 handler 按 env 解析。 */
    store?: JevJudgeUsageStore | null | 'env';
  } = {},
): Promise<{ statusCode: number; body: unknown }> {
  const res = makeResponse();
  const { store } = options;
  // 'env' = 不传 usageStore，让 handler 按 env 解析；undefined = 缺省注入一次性内存 store。
  const usageStore = store === undefined ? createInMemoryJevJudgeUsageStore() : store === 'env' ? undefined : store;
  await handleJevJudgeRequest(makeRequest(options.token === undefined ? TOKEN_A : options.token, options.body ?? GOOD_BODY), res, {
    env,
    fetchImpl: options.fetchImpl ?? makeUpstreamFetch([]),
    ...(usageStore !== undefined && { usageStore }),
  });
  return { statusCode: res.statusCode, body: res.body };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('jev-judge handler：方法/鉴权/形状', () => {
  it('非 POST → 405 method_not_allowed', async () => {
    const res = makeResponse();
    await handleJevJudgeRequest({ method: 'GET', headers: {} }, res, { env: makeEnv() });
    expect(res.statusCode).toBe(405);
    expect(res.body).toMatchObject({ error: 'method_not_allowed' });
  });

  it('无 token → 401 jev_auth_required；无效 token → 401；均不触达上游', async () => {
    const calls: CapturedUpstreamCall[] = [];
    const fetchImpl = makeUpstreamFetch(calls);
    const missing = await callHandler(makeEnv(), { token: null, fetchImpl });
    expect(missing.statusCode).toBe(401);
    expect(missing.body).toMatchObject({ error: 'jev_auth_required' });
    const invalid = await callHandler(makeEnv(), { token: 'not-in-map', fetchImpl });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.body).toMatchObject({ error: 'jev_auth_required' });
    expect(calls).toHaveLength(0);
  });

  it('body 缺 state/questions 对象 → 400 jev_bad_request（不打上游）', async () => {
    const calls: CapturedUpstreamCall[] = [];
    const result = await callHandler(makeEnv(), { body: { state: 'x' }, fetchImpl: makeUpstreamFetch(calls) });
    expect(result.statusCode).toBe(400);
    expect(result.body).toMatchObject({ error: 'jev_bad_request' });
    expect(calls).toHaveLength(0);
  });
});

describe('jev-judge handler：ok 路径与模型 pin', () => {
  it('ok：200 {answers}，上游带 Bearer TYPESAFE key、模型为服务端缺省 pin 值', async () => {
    const calls: CapturedUpstreamCall[] = [];
    const result = await callHandler(makeEnv(), { fetchImpl: makeUpstreamFetch(calls) });
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ answers: ANSWERS });
    expect(calls).toHaveLength(1);
    expect(calls[0].authorization).toBe(`Bearer ${TYPESAFE_KEY}`);
    expect(calls[0].body.model).toBe(DEFAULT_JEV_JUDGE_MODEL);
  });

  it('客户端伪造 model 字段被丢弃：上游 body 的 model 仍是服务端 pin 值', async () => {
    const calls: CapturedUpstreamCall[] = [];
    await callHandler(makeEnv(), { body: { ...GOOD_BODY, model: 'attacker-model' }, fetchImpl: makeUpstreamFetch(calls) });
    expect(calls[0].body.model).toBe(DEFAULT_JEV_JUDGE_MODEL);
    expect(calls[0].body.model).not.toBe('attacker-model');
  });

  it('JEV_JUDGE_MODEL env 覆盖 pin 值', async () => {
    const calls: CapturedUpstreamCall[] = [];
    await callHandler(makeEnv({ JEV_JUDGE_MODEL: 'jev-9.9.9-canary' }), { fetchImpl: makeUpstreamFetch(calls) });
    expect(calls[0].body.model).toBe('jev-9.9.9-canary');
  });

  it('服务端缺省模型与客户端 JEV_MODEL 常量一致（漂移即红）', () => {
    expect(DEFAULT_JEV_JUDGE_MODEL).toBe(JEV_MODEL);
    expect(DEFAULT_JEV_JUDGE_INPUT_USD_PER_MTOK).toBe(0.042);
  });
});

describe('jev-judge handler：配额', () => {
  it('每用户 500/UTC 日：第 501 次 429 jev_user_daily_limit，另一用户仍可用', async () => {
    const calls: CapturedUpstreamCall[] = [];
    const fetchImpl = makeUpstreamFetch(calls);
    const env = makeEnv();
    const store = createInMemoryJevJudgeUsageStore();
    let last: { statusCode: number; body: unknown } = { statusCode: 0, body: null };
    for (let index = 0; index < 501; index += 1) {
      last = await callHandler(env, { token: TOKEN_A, fetchImpl, store });
    }
    expect(calls).toHaveLength(500);
    expect(last.statusCode).toBe(429);
    expect(last.body).toMatchObject({ error: 'jev_user_daily_limit' });

    const userB = await callHandler(env, { token: TOKEN_B, fetchImpl, store });
    expect(userB.statusCode).toBe(200);
    expect(calls).toHaveLength(501);
  });

  it('全局日预算打满 → 503 jev_global_fuse（先到量再拒绝）', async () => {
    // 预算 = 1.5 × 单次估算成本：第 1 次放行（累计 1×），第 2 次熔断（累计 2× > 1.5×）。
    const perCallUsd = estimateJevJudgeCallUsd(Buffer.byteLength(JSON.stringify(GOOD_BODY)), {});
    const calls: CapturedUpstreamCall[] = [];
    const fetchImpl = makeUpstreamFetch(calls);
    const env = makeEnv({ JEV_JUDGE_GLOBAL_DAILY_USD: String(perCallUsd * 1.5) });
    const store = createInMemoryJevJudgeUsageStore();
    const first = await callHandler(env, { fetchImpl, store });
    expect(first.statusCode).toBe(200);
    const second = await callHandler(env, { fetchImpl, store });
    expect(second.statusCode).toBe(503);
    expect(second.body).toMatchObject({ error: 'jev_global_fuse' });
    expect(calls).toHaveLength(1);
  });

  it('store 抛错 → 503 jev_counter_unavailable，上游零调用（fail-closed）', async () => {
    const calls: CapturedUpstreamCall[] = [];
    const throwingStore = {
      consume: () => {
        throw new Error('db down');
      },
    };
    const result = await callHandler(makeEnv(), { fetchImpl: makeUpstreamFetch(calls), store: throwingStore });
    expect(result.statusCode).toBe(503);
    expect(result.body).toMatchObject({ error: 'jev_counter_unavailable' });
    expect(calls).toHaveLength(0);
  });

  it('未配置 store（无 DATABASE_URL 且未开内存开关）→ 503 jev_counter_unavailable，上游零调用', async () => {
    const calls: CapturedUpstreamCall[] = [];
    const res = makeResponse();
    await handleJevJudgeRequest(makeRequest(TOKEN_A, GOOD_BODY), res, {
      env: makeEnv(),
      fetchImpl: makeUpstreamFetch(calls),
      usageStore: null,
    });
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: 'jev_counter_unavailable' });
    expect(calls).toHaveLength(0);
  });

  it('env 解析的内存 store 跨请求复用（限额真实累计）：限 1 次时第 2 次 429', async () => {
    const calls: CapturedUpstreamCall[] = [];
    const fetchImpl = makeUpstreamFetch(calls);
    const env = makeEnv({
      JEV_JUDGE_ALLOW_MEMORY_STORE: '1',
      JEV_JUDGE_USER_DAILY_CALLS: '1',
    });
    const first = await callHandler(env, { token: TOKEN_A, fetchImpl, store: 'env' });
    expect(first.statusCode).toBe(200);
    const second = await callHandler(env, { token: TOKEN_A, fetchImpl, store: 'env' });
    expect(second.statusCode).toBe(429);
    expect(second.body).toMatchObject({ error: 'jev_user_daily_limit' });
    expect(calls).toHaveLength(1);
  });

  it('413：序列化 body 超过 JEV_JUDGE_MAX_BODY_BYTES', async () => {
    const calls: CapturedUpstreamCall[] = [];
    const bigBody = { state: { blob: 'x'.repeat(4096) }, questions: {} };
    const result = await callHandler(makeEnv({ JEV_JUDGE_MAX_BODY_BYTES: '1024' }), {
      body: bigBody,
      fetchImpl: makeUpstreamFetch(calls),
    });
    expect(result.statusCode).toBe(413);
    expect(result.body).toMatchObject({ error: 'jev_body_too_large' });
    expect(calls).toHaveLength(0);
  });
});

describe('jev-judge handler：key 与请求体不泄漏', () => {
  it('上游 5xx 错误体含 key 也不回显：502 响应 JSON 不含 key；成功路径同理', async () => {
    const leakingFetch = vi.fn(async () => new Response(
      JSON.stringify({ error: 'boom', key: TYPESAFE_KEY, state_echo: GOOD_BODY.state }),
      { status: 500 },
    )) as unknown as typeof fetch;
    const result = await callHandler(makeEnv(), { fetchImpl: leakingFetch });
    expect(result.statusCode).toBe(502);
    expect(result.body).toMatchObject({ error: 'jev_upstream_error' });
    expect(JSON.stringify(result.body)).not.toContain(TYPESAFE_KEY);
    expect(JSON.stringify(result.body)).not.toContain('npm view left-pad');
  });

  it('全程零 console 输出（不打请求体/key 日志）', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'info'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    await callHandler(makeEnv());
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

describe('成本估算与常量口径', () => {
  it('estimateJevJudgeCallUsd：ceil(bytes/4) tokens × 0.042/Mtok', () => {
    // 4,000,000 字节 → 1,000,000 tokens → $0.042
    expect(estimateJevJudgeCallUsd(4_000_000, {})).toBeCloseTo(0.042, 12);
    // 1 字节也按 1 token 计
    expect(estimateJevJudgeCallUsd(1, {})).toBeCloseTo(0.042 / 1_000_000, 15);
    // env 覆盖单价
    expect(estimateJevJudgeCallUsd(4_000_000, { JEV_JUDGE_INPUT_USD_PER_MTOK: '0.084' })).toBeCloseTo(0.084, 12);
  });
});

describe('resolveControlPlaneSubject（新导出的主体解析器）', () => {
  it('token map：有效 token → subject（server_token_map）；无效/缺失 → null', async () => {
    const env = makeEnv();
    await expect(resolveControlPlaneSubject(makeRequest(TOKEN_A, {}), env)).resolves.toMatchObject({
      id: 'user-a',
      source: 'server_token_map',
    });
    await expect(resolveControlPlaneSubject(makeRequest('nope', {}), env)).resolves.toBeNull();
    await expect(resolveControlPlaneSubject(makeRequest(null, {}), env)).resolves.toBeNull();
  });

  it('开放模式（无任何鉴权配置）→ null（托管判官必须有已验证主体）', async () => {
    await expect(resolveControlPlaneSubject(makeRequest(TOKEN_A, {}), {})).resolves.toBeNull();
  });

  it('Supabase 模式：access token 换 subject（stub 全局 fetch /auth/v1/user），handler 全链路放行', async () => {
    const env = makeEnv({
      CONTROL_PLANE_SUPABASE_URL: 'https://stub.supabase.co',
      CONTROL_PLANE_SUPABASE_ANON_KEY: 'anon-key',
    });
    delete (env as Record<string, string | undefined>).CONTROL_PLANE_ENTITLEMENT_TOKEN_MAP_JSON;

    const originalFetch = globalThis.fetch;
    const calls: CapturedUpstreamCall[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.startsWith('https://stub.supabase.co/auth/v1/user')) {
        return new Response(JSON.stringify({ id: 'supa-user-1', email: 'supa@example.com' }), { status: 200 });
      }
      calls.push({
        url: target,
        authorization: String((init?.headers as Record<string, string>)?.Authorization ?? ''),
        body: JSON.parse(String(init?.body)) as CapturedUpstreamCall['body'],
      });
      return new Response(JSON.stringify({ answers: ANSWERS }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const subject = await resolveControlPlaneSubject(makeRequest('supabase-jwt-1', {}), env);
      expect(subject).toMatchObject({ id: 'supa-user-1', source: 'supabase_auth' });

      const result = await callHandler(env, { token: 'supabase-jwt-2', fetchImpl: globalThis.fetch });
      expect(result.statusCode).toBe(200);
      expect(result.body).toEqual({ answers: ANSWERS });
      expect(calls).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
