// ============================================================================
// Jev 托管判官（N-JEV-NEO-KEY）—— Neo 出钱的计量代理 handler
// ----------------------------------------------------------------------------
// TypeSafe key 只从本进程 env（TYPESAFE_API_KEY）读，永不进响应/日志/客户端。
// 顺序（任务书 1，不得调换）：鉴权 → 原子消费配额 → 打上游 → 回答案。
// 错误码：401 jev_auth_required / 429 jev_user_daily_limit / 503 jev_global_fuse /
// 503 jev_counter_unavailable（fail-closed：计数不可用绝不打上游）/ 502 jev_upstream_error。
// 不打请求体日志、不回显上游错误体——两者都可能携带敏感内容或 key。
// ============================================================================

import type { ControlPlaneRequestLike, ControlPlaneResponseLike } from './controlPlaneEnvelope.js';
import { resolveControlPlaneSubject } from './controlPlaneEntitlements.js';
import {
  createInMemoryJevJudgeUsageStore,
  createPostgresJevJudgeUsageStore,
  type JevJudgeUsageStore,
} from './jevJudgeUsageStore.js';

/**
 * 服务端 pin 的判官模型缺省值。必须与 src/shared/constants/jevQuestions.ts 的
 * JEV_MODEL 保持一致（单测钉死）；换版本走 JEV_JUDGE_MODEL env。
 */
export const DEFAULT_JEV_JUDGE_MODEL = 'jev-1.13.0';

/**
 * 成本估算用的输入刊例（USD / Mtok）。镜像 src/shared/constants/jevQuestions.ts 的
 * JEV_INPUT_USD_PER_MTOK（0.042，输出免费）——vercel-api 不 import src/，靠单测钉同步。
 */
export const DEFAULT_JEV_JUDGE_INPUT_USD_PER_MTOK = 0.042;

/** 每用户每日调用上限缺省值（UTC 日窗口）。 */
export const DEFAULT_JEV_JUDGE_USER_DAILY_CALLS = 500;

/** 全局每日成本熔断缺省值（USD）。 */
export const DEFAULT_JEV_JUDGE_GLOBAL_DAILY_USD = 1.0;

/** 请求体大小上限缺省值（字节，按序列化后的 JSON 计）。 */
export const DEFAULT_JEV_JUDGE_MAX_BODY_BYTES = 512 * 1024;

/** 上游 TypeSafe 调用超时缺省值（ms）。 */
export const DEFAULT_JEV_JUDGE_UPSTREAM_TIMEOUT_MS = 10_000;

/** TypeSafe systemOne 端点缺省值（与客户端 MODEL_API_ENDPOINTS.typesafeSystemOne 同源）。 */
export const DEFAULT_JEV_JUDGE_TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

const MODEL_ENV_NAMES = ['JEV_JUDGE_MODEL', 'CODE_AGENT_JEV_JUDGE_MODEL'];
const PRICE_ENV_NAMES = ['JEV_JUDGE_INPUT_USD_PER_MTOK', 'CODE_AGENT_JEV_JUDGE_INPUT_USD_PER_MTOK'];
const USER_CALLS_ENV_NAMES = ['JEV_JUDGE_USER_DAILY_CALLS', 'CODE_AGENT_JEV_JUDGE_USER_DAILY_CALLS'];
const GLOBAL_USD_ENV_NAMES = ['JEV_JUDGE_GLOBAL_DAILY_USD', 'CODE_AGENT_JEV_JUDGE_GLOBAL_DAILY_USD'];
const MAX_BODY_ENV_NAMES = ['JEV_JUDGE_MAX_BODY_BYTES', 'CODE_AGENT_JEV_JUDGE_MAX_BODY_BYTES'];
const UPSTREAM_TIMEOUT_ENV_NAMES = ['JEV_JUDGE_UPSTREAM_TIMEOUT_MS', 'CODE_AGENT_JEV_JUDGE_UPSTREAM_TIMEOUT_MS'];
const TYPESAFE_ENDPOINT_ENV_NAMES = ['JEV_JUDGE_TYPESAFE_ENDPOINT', 'CODE_AGENT_JEV_JUDGE_TYPESAFE_ENDPOINT'];
const TYPESAFE_KEY_ENV_NAMES = ['TYPESAFE_API_KEY'];
const DATABASE_URL_ENV_NAMES = ['DATABASE_URL'];
const ALLOW_MEMORY_STORE_ENV_NAMES = ['JEV_JUDGE_ALLOW_MEMORY_STORE'];

function readEnv(env: NodeJS.ProcessEnv, names: string[]): string | null {
  for (const name of names) {
    const value = env[name];
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function readNumberEnv(env: NodeJS.ProcessEnv, names: string[], fallback: number): number {
  const raw = readEnv(env, names);
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** 一次调用的成本估算：tokens = ceil(body bytes / 4)，输出免费（与 estimateJevCallUsd 同口径）。 */
export function estimateJevJudgeCallUsd(bodyBytes: number, env: NodeJS.ProcessEnv): number {
  const price = readNumberEnv(env, PRICE_ENV_NAMES, DEFAULT_JEV_JUDGE_INPUT_USD_PER_MTOK);
  const tokens = Math.ceil(Math.max(0, bodyBytes) / 4);
  return (tokens * price) / 1_000_000;
}

/** UTC 日键（YYYY-MM-DD）：配额窗口。 */
export function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * 从 env 解析计数 store：DATABASE_URL → postgres；显式 JEV_JUDGE_ALLOW_MEMORY_STORE=1 →
 * 内存（仅本地开发/测试，per-process 复用同一实例，否则限额永远不累计）；否则 null
 * （计数不可用，handler fail-closed 拒绝全部调用）。
 */
let memoizedMemoryStore: JevJudgeUsageStore | null = null;

export async function resolveJevJudgeUsageStore(env: NodeJS.ProcessEnv): Promise<JevJudgeUsageStore | null> {
  const databaseUrl = readEnv(env, DATABASE_URL_ENV_NAMES);
  if (databaseUrl) {
    const postgres = (await import('postgres')).default;
    return createPostgresJevJudgeUsageStore(databaseUrl, postgres);
  }
  if (readEnv(env, ALLOW_MEMORY_STORE_ENV_NAMES) === '1') {
    if (!memoizedMemoryStore) {
      memoizedMemoryStore = createInMemoryJevJudgeUsageStore();
    }
    return memoizedMemoryStore;
  }
  return null;
}

export interface JevJudgeHandlerOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** 不传（undefined）则按 env 解析（postgres / 内存 / null→fail-closed）；显式 null = 强制无计数器。 */
  usageStore?: JevJudgeUsageStore | null;
  now?: () => Date;
}

interface JevJudgeRequestShape {
  state: Record<string, unknown>;
  questions: Record<string, unknown>;
}

function sendError(res: ControlPlaneResponseLike, statusCode: number, code: string, message: string): void {
  res.status(statusCode).json({ error: code, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRequestBodyBytes(body: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(body ?? null));
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function parseJevJudgeBody(body: unknown): JevJudgeRequestShape | null {
  if (!isRecord(body)) {
    return null;
  }
  const { state, questions } = body as { state?: unknown; questions?: unknown };
  // 客户端可能带 model 字段——一律丢弃，模型只认服务端 env（pin 服务端）。
  if (!isRecord(state) || !isRecord(questions)) {
    return null;
  }
  return { state, questions };
}

export async function handleJevJudgeRequest(
  req: ControlPlaneRequestLike,
  res: ControlPlaneResponseLike,
  options: JevJudgeHandlerOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());

  if (req.method?.toUpperCase() !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendError(res, 405, 'method_not_allowed', 'Only POST is supported.');
    return;
  }

  // 1) 请求体上限（对序列化字节计）：超限 413，先于鉴权（省 Supabase 往返）。
  const bodyBytes = readRequestBodyBytes(req.body);
  if (bodyBytes > readNumberEnv(env, MAX_BODY_ENV_NAMES, DEFAULT_JEV_JUDGE_MAX_BODY_BYTES)) {
    sendError(res, 413, 'jev_body_too_large', 'Request body exceeds the size limit.');
    return;
  }

  // 2) 鉴权：控制面主体（Supabase access token 或 token map）。解析不出主体即拒。
  const subject = await resolveControlPlaneSubject(req, env);
  if (!subject) {
    sendError(res, 401, 'jev_auth_required', 'A verified control-plane subject is required.');
    return;
  }

  const parsedBody = parseJevJudgeBody(req.body);
  if (!parsedBody) {
    sendError(res, 400, 'jev_bad_request', 'Body must be a JSON object with state and questions objects.');
    return;
  }

  // 3) 原子消费配额。计数不可用（无 DATABASE_URL 且未开内存 store / store 抛错）→
  //    fail-closed 503，绝不绕过计数打上游。
  const store = options.usageStore !== undefined ? options.usageStore : await resolveJevJudgeUsageStore(env);
  if (!store) {
    sendError(res, 503, 'jev_counter_unavailable', 'Usage counters are unavailable; request refused.');
    return;
  }
  let quota: Awaited<ReturnType<JevJudgeUsageStore['consume']>> | null = null;
  try {
    quota = await store.consume({
      userId: subject.id,
      day: utcDayKey(now()),
      estCostUsd: estimateJevJudgeCallUsd(bodyBytes, env),
      userCallLimit: readNumberEnv(env, USER_CALLS_ENV_NAMES, DEFAULT_JEV_JUDGE_USER_DAILY_CALLS),
      globalCostLimitUsd: readNumberEnv(env, GLOBAL_USD_ENV_NAMES, DEFAULT_JEV_JUDGE_GLOBAL_DAILY_USD),
    });
  } catch {
    quota = null;
  }
  if (quota === null) {
    sendError(res, 503, 'jev_counter_unavailable', 'Usage counters are unavailable; request refused.');
    return;
  }
  if (!quota.allowed) {
    if (quota.reason === 'global_fuse') {
      sendError(res, 503, 'jev_global_fuse', 'The global daily judge budget is exhausted.');
      return;
    }
    sendError(res, 429, 'jev_user_daily_limit', 'Daily judge call allowance is used up; resets next UTC day.');
    return;
  }

  // 4) 打上游。key 只从 env 读；模型只从 env 读（缺省 = 与客户端 JEV_MODEL 同版本）。
  const apiKey = readEnv(env, TYPESAFE_KEY_ENV_NAMES);
  if (!apiKey) {
    sendError(res, 503, 'jev_upstream_unconfigured', 'Upstream judge key is not configured.');
    return;
  }
  const model = readEnv(env, MODEL_ENV_NAMES) ?? DEFAULT_JEV_JUDGE_MODEL;
  const endpoint = readEnv(env, TYPESAFE_ENDPOINT_ENV_NAMES) ?? DEFAULT_JEV_JUDGE_TYPESAFE_ENDPOINT;
  const timeoutMs = readNumberEnv(env, UPSTREAM_TIMEOUT_ENV_NAMES, DEFAULT_JEV_JUDGE_UPSTREAM_TIMEOUT_MS);

  let upstream: Response;
  try {
    upstream = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ state: parsedBody.state, model, questions: parsedBody.questions }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    sendError(res, 502, 'jev_upstream_error', 'Upstream judge request failed.');
    return;
  }
  if (!upstream.ok) {
    // 不回显上游错误体：可能含敏感回显，且无法证明不含 key。
    sendError(res, 502, 'jev_upstream_error', `Upstream judge rejected the request (HTTP ${upstream.status}).`);
    return;
  }
  let answersPayload: unknown;
  try {
    answersPayload = await upstream.json();
  } catch {
    sendError(res, 502, 'jev_upstream_error', 'Upstream judge returned a non-JSON body.');
    return;
  }
  if (!isRecord(answersPayload) || !isRecord(answersPayload.answers)) {
    sendError(res, 502, 'jev_upstream_error', 'Upstream judge response is missing the answers object.');
    return;
  }
  res.status(200).json({ answers: answersPayload.answers });
}
