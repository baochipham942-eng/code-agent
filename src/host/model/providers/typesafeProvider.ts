// ============================================================================
// TypeSafe Jev（System One）provider —— 判断面专用，只暴露 systemOne
// ============================================================================
// POST decisions，body { state, model, questions }（见 buildJevDecisionRequestBody），
// 返回 { answers: { <qname>: { choice, confidence } | { noul } | { score, confidence } } }。
// 一次请求里的问题独立并行评估——问句与阈值全在 shared/constants/jevQuestions.ts，本文件不含判定。
//
// 边界（有意为之）：
// - 不实现聊天面 Provider.inference（死表面不建），不进聊天 provider 目录/模型目录。
// - 官方 key 只经 providerResolution（typesafe→TYPESAFE_API_KEY）打官方端点。
//   没有官方 key 时才读 getConfigService().getApiKey('openrouter')，只打 OpenRouter decisions。
//   两把 key 不交叉。都没有则 null / TYPESAFE_KEY_MISSING，本层不发请求。
// - 借用 OpenRouter key 受知情同意闸门（N-JEV-DEFAULT-ON-CONSENT）：用户总开关关、或
//   只有 OpenRouter key 且未同意 → 视同无 key（null），与「无 key」行为完全一致。
// - 两把 key 都没有且已登录 → Neo 托管判官（N-JEV-NEO-KEY）：打云端计量代理
//   CLOUD_ENDPOINTS.jevJudge，TypeSafe key 只在服务端；模型由服务端 pin（请求体不带
//   model）。限流（429/503）进入 per-process blocked-until 退避（jevHostedQuota.ts），
//   到点前视同无路由。有 OpenRouter key（即使未同意）不走托管——不让「Neo 出钱」
//   变成绕过同意闸门的旁路。
// - 400/404/422 → TYPESAFE_ROUTE_REJECTED；其余非 2xx → TYPESAFE_HTTP_ERROR。
//   超时 / JSON 形状不对仍抛带 code 的 Error。fail-closed 动作由调用方决定。
// ============================================================================

import { CLOUD_ENDPOINTS, JEV_OPENROUTER_MODEL, MODEL_API_ENDPOINTS } from '../../../shared/constants';
import {
  JEV_MODEL,
  JEV_TIMEOUT_MS,
  type JevAnswers,
  type JevQuestionSpec,
} from '../../../shared/constants/jevQuestions';
import type { JevKeySource } from '../../../shared/contract/jev';
import { createLogger } from '../../services/infra/logger';
import { getConfigService } from '../../services/core/configService';
// 深路径直取 authService：barrel（services/auth/index.ts）会拖进 tokenManager →
// serviceRegistry 整条链，污染本模块在单测里的 mock 边界。
import { getAuthService } from '../../services/auth/authService';
import { blockJevHosted, getJevHostedBlock } from '../jevHostedQuota';
import { buildJevDecisionRequestBody, postJevDecision, type JevRoute } from './jevDecisionRequest';
import { resolveProviderApiKey } from './providerResolution';

export type { JevRoute };

const logger = createLogger('TypeSafe');

/** 抛错时挂在 Error.code 上的稳定码（调用方按码决定 warn 口径，不用于重试）。 */
const TYPESAFE_ERROR_CODES = {
  missingKey: 'TYPESAFE_KEY_MISSING',
  httpError: 'TYPESAFE_HTTP_ERROR',
  routeRejected: 'TYPESAFE_ROUTE_REJECTED',
  timeout: 'TYPESAFE_TIMEOUT',
  badShape: 'TYPESAFE_BAD_SHAPE',
  hostedUserLimit: 'JEV_HOSTED_USER_LIMIT',
  hostedFuse: 'JEV_HOSTED_GLOBAL_FUSE',
  hostedAuthTokenMissing: 'JEV_HOSTED_AUTH_TOKEN_MISSING',
  hostedAuthRequired: 'JEV_HOSTED_AUTH_REQUIRED',
} as const;

const ROUTE_REJECTED_STATUSES = new Set([400, 404, 422]);

function fail(code: string, message: string): never {
  const error = new Error(`[typesafe] ${message}`) as Error & { code: string };
  error.code = code;
  throw error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function presentKey(value: string | undefined | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function redactSecret(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join('[redacted]');
}

/**
 * Jev 用户开关（config.json settings.jev）：总开关缺省开、OpenRouter 借用同意缺省未给、
 * Neo 托管判官缺省开（N-JEV-NEO-KEY）。configService 不可用（CLI/测试骨架）按缺省处理——
 * 缺省口径下官方 key 照常可用。
 */
function readJevUserSwitches(): { enabled: boolean; openRouterConsent: boolean; neoHostedEnabled: boolean } {
  try {
    const jev = getConfigService().getSettings().jev;
    return {
      enabled: jev?.enabled !== false,
      openRouterConsent: jev?.openRouterConsent === true,
      neoHostedEnabled: jev?.neoHostedEnabled !== false,
    };
  } catch {
    return { enabled: true, openRouterConsent: false, neoHostedEnabled: true };
  }
}

/** 托管路由资格的同步判据：已登录（getCurrentUser 同步；token 在请求时再异步取）。 */
function isUserLoggedIn(): boolean {
  try {
    return getAuthService().getCurrentUser() !== null;
  } catch {
    return false;
  }
}

interface JevKeyResolution {
  source: JevKeySource;
  officialKey: string | null;
  openrouterKey: string | null;
}

function resolveJevKeys(): JevKeyResolution {
  const switches = readJevUserSwitches();
  if (!switches.enabled) return { source: 'disabled_by_user', officialKey: null, openrouterKey: null };
  const officialKey = presentKey(resolveProviderApiKey({ provider: 'typesafe', model: JEV_MODEL }));
  if (officialKey) return { source: 'official', officialKey, openrouterKey: null };
  const openrouterKey = presentKey(getConfigService().getApiKey('openrouter'));
  if (openrouterKey) {
    // 有 OpenRouter key（无论是否已同意借用）都不走托管：同意闸门 UI 保持原样，
    // 不让「Neo 出钱」变成绕过同意的旁路（取舍记录于证据档 N-JEV-NEO-KEY）。
    return {
      source: switches.openRouterConsent ? 'openrouter' : 'openrouter_pending_consent',
      officialKey: null,
      openrouterKey,
    };
  }
  // 官方 key 与 OpenRouter key 都没有：已登录且两道开关都开 → Neo 托管判官。
  if (switches.neoHostedEnabled && isUserLoggedIn()) {
    return { source: 'neo_hosted', officialKey: null, openrouterKey: null };
  }
  return { source: 'none', officialKey: null, openrouterKey: null };
}

const NULL_ROUTE_REASON_TEXT: Record<Exclude<JevKeySource, 'official' | 'openrouter' | 'neo_hosted'>, string> = {
  none: 'TYPESAFE_API_KEY 与 OpenRouter key 均未配置，且 Neo 托管判官不可用（未登录或云判官开关关）',
  disabled_by_user: '用户已在设置中关闭 Jev 总开关',
  openrouter_pending_consent: '检测到 OpenRouter key，但用户尚未允许借用（不借用用户 key）',
};
const warnedNullSources = new Set<keyof typeof NULL_ROUTE_REASON_TEXT>();

/** 路由不可用的可区分留痕：每个原因每进程至多一条 warn（降级必须留痕，错题本 2026-08-14）。 */
function warnNullRouteOnce(source: keyof typeof NULL_ROUTE_REASON_TEXT): void {
  if (warnedNullSources.has(source)) return;
  warnedNullSources.add(source);
  logger.warn(`[typesafe] Jev 路由不可用（${source}）：${NULL_ROUTE_REASON_TEXT[source]}，本进程仅此一条`);
}

/**
 * 状态探针（只读、无副作用、不 warn）：settings 页与诊断用。
 * official | openrouter | neo_hosted | openrouter_pending_consent | disabled_by_user | none。
 */
export function probeJevKeySource(): JevKeySource {
  return resolveJevKeys().source;
}

/**
 * 托管资格探针（不含退避/子开关判定）：无两把自有 key、总开关开、已登录。
 * 云判官子开关关时仍为 true——设置页据此保留子开关行，关掉后还能再打开。
 */
export function probeJevHostedEligible(): boolean {
  const switches = readJevUserSwitches();
  if (!switches.enabled) return false;
  if (presentKey(resolveProviderApiKey({ provider: 'typesafe', model: JEV_MODEL }))) return false;
  if (presentKey(getConfigService().getApiKey('openrouter'))) return false;
  return isUserLoggedIn();
}

/**
 * 官方 key 优先。没有官方 key 才用 OpenRouter key（须用户已同意借用）；两把 key 都
 * 没有且已登录、两道开关都开 → Neo 托管判官（计量代理，key 只在服务端）。
 * 总开关关 / 未同意借用 / 都没有且不符合托管资格 → null，行为与「无 key」完全一致。
 * 官方 key 存在时不读取 OpenRouter key。托管路由被限流（blocked-until 未到点）时
 * 同样返回 null（blockJevHosted 已留痕，这里不再重复 warn）。
 */
export function resolveJevRoute(): JevRoute | null {
  const resolution = resolveJevKeys();
  if (resolution.source === 'official' && resolution.officialKey) {
    return {
      kind: 'official',
      endpoint: MODEL_API_ENDPOINTS.typesafeSystemOne,
      model: JEV_MODEL,
      apiKey: resolution.officialKey,
    };
  }
  if (resolution.source === 'openrouter' && resolution.openrouterKey) {
    return {
      kind: 'openrouter',
      endpoint: MODEL_API_ENDPOINTS.openrouterDecisions,
      model: JEV_OPENROUTER_MODEL,
      apiKey: resolution.openrouterKey,
    };
  }
  if (resolution.source === 'neo_hosted') {
    if (!getJevHostedBlock()) {
      return {
        kind: 'neo_hosted',
        endpoint: CLOUD_ENDPOINTS.jevJudge,
        model: JEV_MODEL,
        // apiKey 是请求时取的云端 access token（systemOne 内异步获取）；这里恒空串。
        apiKey: '',
      };
    }
    return null;
  }
  warnNullRouteOnce(resolution.source as keyof typeof NULL_ROUTE_REASON_TEXT);
  return null;
}

function rejectHttp(route: JevRoute, status: number, body: string): never {
  const echoed = redactSecret(body, route.apiKey).slice(0, 200);
  const suffix = echoed ? `: ${echoed}` : '';
  if (ROUTE_REJECTED_STATUSES.has(status)) {
    fail(
      TYPESAFE_ERROR_CODES.routeRejected,
      `systemOne ${route.kind} model or endpoint rejected: HTTP ${status} model=${route.model} endpoint=${route.endpoint}${suffix}`,
    );
  }
  fail(TYPESAFE_ERROR_CODES.httpError, `systemOne HTTP ${status}${suffix}`);
}

/**
 * 托管端点的结构化错误（{error, message}）：限流两码 + 持续性服务故障映射 per-process blocked-until
 * （用户日限 → 下一个 UTC 日界；熔断 → 30 分钟），此后 resolveJevRoute() 不再给出
 * 托管路由，判官特性按既有无路由路径降级。blockJevHosted 内部每原因 warn 一条。
 */
function rejectHosted(route: JevRoute, status: number, body: string): never {
  let errorCode: string | null = null;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (isRecord(parsed) && typeof parsed.error === 'string') {
      errorCode = parsed.error;
    }
  } catch {
    // 非 JSON 错误体走通用 HTTP 口径。
  }
  if (status === 429 && errorCode === 'jev_user_daily_limit') {
    const block = blockJevHosted('user_daily_limit');
    fail(
      TYPESAFE_ERROR_CODES.hostedUserLimit,
      `Neo hosted judge daily allowance used up; retrying after ${new Date(block.blockedUntil).toISOString()}`,
    );
  }
  if (status === 503 && errorCode === 'jev_global_fuse') {
    const block = blockJevHosted('global_fuse');
    fail(
      TYPESAFE_ERROR_CODES.hostedFuse,
      `Neo hosted judge global fuse open; retrying after ${new Date(block.blockedUntil).toISOString()}`,
    );
  }
  // 持续性服务故障（云端漏配 / 未部署 / 鉴权模式不匹配 / 上游挂）：短退避，避免此后每次判官调用
  // 都先付一次云端往返才降级。请求级 4xx（如 400 坏请求）不算服务故障、不退避。
  const persistent = status === 401 || status === 403 || status === 404 || status === 405 || status >= 500;
  if (persistent) {
    blockJevHosted('service_unavailable', Date.now(), `HTTP ${status}${errorCode ? ` ${errorCode}` : ''}`);
  }
  if (status === 401 && errorCode === 'jev_auth_required') {
    fail(TYPESAFE_ERROR_CODES.hostedAuthRequired, 'Neo hosted judge rejected the cloud access token');
  }
  rejectHttp(route, status, body);
}

/** 托管路由的 access token（请求时异步取）。拿不到时 warn 一次并按无路由失败。 */
let warnedHostedAuthToken = false;
async function fetchJevHostedAccessToken(): Promise<string | null> {
  try {
    const token = await getAuthService().getAccessToken();
    if (token) return token;
  } catch {
    // fall through to the single warn below
  }
  if (!warnedHostedAuthToken) {
    warnedHostedAuthToken = true;
    logger.warn('[typesafe] 已登录用户拿不到云端 access token，Neo 托管判官本次不可用（本进程仅此一条）');
  }
  return null;
}

/** 把 AbortSignal 接到 response.json()：fetch 已返回后超时仍能掐断永不结束的 body。 */
function readJsonUntilAbort(response: Response, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    void response.json().then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * 一次 System One 判面调用。state 里的集合用命名键（数组下标引用实测判错，
 * 见 docs/research/2026-09-19-jev-typesafe-集成场景分析.md §2 G）。调用方负责
 * 把 state 里每个字符串先过 guardSensitiveText——本层不做脱敏。
 */
export async function systemOne(
  state: Record<string, unknown>,
  questions: Record<string, JevQuestionSpec>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<JevAnswers> {
  const route = resolveJevRoute();
  if (!route) {
    fail(
      TYPESAFE_ERROR_CODES.missingKey,
      'TYPESAFE_API_KEY and OpenRouter key are both unset',
    );
  }

  // 托管路由：资格判定在 resolveJevKeys（同步 getCurrentUser），token 到请求时才取。
  let effectiveRoute = route;
  if (route.kind === 'neo_hosted') {
    const token = await fetchJevHostedAccessToken();
    if (!token) {
      fail(
        TYPESAFE_ERROR_CODES.hostedAuthTokenMissing,
        'logged-in user has no cloud access token for the Neo hosted judge',
      );
    }
    effectiveRoute = { ...route, apiKey: token };
  }

  const timeoutMs = options.timeoutMs ?? JEV_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort);

  const timedOutOrAborted = (error?: unknown): boolean =>
    timedOut || (options.signal?.aborted ?? false) || isAbortError(error);

  try {
    let response: Response;
    try {
      response = await postJevDecision(
        effectiveRoute,
        buildJevDecisionRequestBody(effectiveRoute, state, questions),
        controller.signal,
      );
    } catch (error) {
      // 托管路由：超时/网络失败是服务故障信号，退避（调用方主动取消不算）。
      if (effectiveRoute.kind === 'neo_hosted' && !(options.signal?.aborted ?? false)) {
        blockJevHosted('service_unavailable', Date.now(), timedOut ? `timeout ${timeoutMs}ms` : 'network error');
      }
      if (timedOutOrAborted(error)) {
        fail(TYPESAFE_ERROR_CODES.timeout, `systemOne 超时（${timeoutMs}ms）或被外部中止`);
      }
      fail(
        TYPESAFE_ERROR_CODES.httpError,
        `systemOne 网络失败: ${redactSecret(error instanceof Error ? error.message : String(error), effectiveRoute.apiKey)}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (effectiveRoute.kind === 'neo_hosted') {
        rejectHosted(effectiveRoute, response.status, body);
      }
      rejectHttp(effectiveRoute, response.status, body);
    }

    let parsed: unknown;
    try {
      parsed = await readJsonUntilAbort(response, controller.signal);
    } catch (error) {
      if (timedOutOrAborted(error)) {
        fail(TYPESAFE_ERROR_CODES.timeout, `systemOne 超时（${timeoutMs}ms）或被外部中止`);
      }
      fail(
        TYPESAFE_ERROR_CODES.badShape,
        `systemOne 响应不是 JSON: ${redactSecret(error instanceof Error ? error.message : String(error), effectiveRoute.apiKey)}`,
      );
    }
    if (!isRecord(parsed) || !isRecord(parsed.answers)) {
      fail(
        TYPESAFE_ERROR_CODES.badShape,
        `systemOne 响应缺 answers 对象: ${redactSecret(JSON.stringify(parsed), effectiveRoute.apiKey).slice(0, 200)}`,
      );
    }
    return parsed.answers as JevAnswers;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}
