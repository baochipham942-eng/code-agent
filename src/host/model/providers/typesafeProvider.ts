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
// - 400/404/422 → TYPESAFE_ROUTE_REJECTED；其余非 2xx → TYPESAFE_HTTP_ERROR。
//   超时 / JSON 形状不对仍抛带 code 的 Error。fail-closed 动作由调用方决定。
// ============================================================================

import { JEV_OPENROUTER_MODEL, MODEL_API_ENDPOINTS } from '../../../shared/constants';
import {
  JEV_MODEL,
  JEV_TIMEOUT_MS,
  type JevAnswers,
  type JevQuestionSpec,
} from '../../../shared/constants/jevQuestions';
import type { JevKeySource } from '../../../shared/contract/jev';
import { createLogger } from '../../services/infra/logger';
import { getConfigService } from '../../services/core/configService';
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
 * Jev 用户开关（config.json settings.jev）：总开关缺省开、OpenRouter 借用同意缺省未给。
 * configService 不可用（CLI/测试骨架）按缺省处理——缺省口径下官方 key 照常可用。
 */
function readJevUserSwitches(): { enabled: boolean; openRouterConsent: boolean } {
  try {
    const jev = getConfigService().getSettings().jev;
    return {
      enabled: jev?.enabled !== false,
      openRouterConsent: jev?.openRouterConsent === true,
    };
  } catch {
    return { enabled: true, openRouterConsent: false };
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
  return {
    source: !openrouterKey ? 'none' : switches.openRouterConsent ? 'openrouter' : 'openrouter_pending_consent',
    officialKey: null,
    openrouterKey,
  };
}

const NULL_ROUTE_REASON_TEXT: Record<Exclude<JevKeySource, 'official' | 'openrouter'>, string> = {
  none: 'TYPESAFE_API_KEY 与 OpenRouter key 均未配置',
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
 * official | openrouter | openrouter_pending_consent | disabled_by_user | none。
 */
export function probeJevKeySource(): JevKeySource {
  return resolveJevKeys().source;
}

/**
 * 官方 key 优先。没有官方 key 才用 OpenRouter key（须用户已同意借用）。
 * 总开关关 / 未同意借用 / 都没有 → null，行为与「无 key」完全一致。
 * 官方 key 存在时不读取 OpenRouter key。
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
        route,
        buildJevDecisionRequestBody(route, state, questions),
        controller.signal,
      );
    } catch (error) {
      if (timedOutOrAborted(error)) {
        fail(TYPESAFE_ERROR_CODES.timeout, `systemOne 超时（${timeoutMs}ms）或被外部中止`);
      }
      fail(
        TYPESAFE_ERROR_CODES.httpError,
        `systemOne 网络失败: ${redactSecret(error instanceof Error ? error.message : String(error), route.apiKey)}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      rejectHttp(route, response.status, body);
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
        `systemOne 响应不是 JSON: ${redactSecret(error instanceof Error ? error.message : String(error), route.apiKey)}`,
      );
    }
    if (!isRecord(parsed) || !isRecord(parsed.answers)) {
      fail(
        TYPESAFE_ERROR_CODES.badShape,
        `systemOne 响应缺 answers 对象: ${redactSecret(JSON.stringify(parsed), route.apiKey).slice(0, 200)}`,
      );
    }
    return parsed.answers as JevAnswers;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}
