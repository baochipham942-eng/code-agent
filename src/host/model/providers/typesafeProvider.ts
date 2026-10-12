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
import { getConfigService } from '../../services/core/configService';
import { buildJevDecisionRequestBody, postJevDecision, type JevRoute } from './jevDecisionRequest';
import { resolveProviderApiKey } from './providerResolution';

export type { JevRoute };

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
 * 官方 key 优先。没有官方 key 才用 OpenRouter key。都没有返回 null。
 * 官方 key 存在时不读取 OpenRouter key。
 */
export function resolveJevRoute(): JevRoute | null {
  const officialKey = presentKey(resolveProviderApiKey({ provider: 'typesafe', model: JEV_MODEL }));
  if (officialKey) {
    return {
      kind: 'official',
      endpoint: MODEL_API_ENDPOINTS.typesafeSystemOne,
      model: JEV_MODEL,
      apiKey: officialKey,
    };
  }
  const openrouterKey = presentKey(getConfigService().getApiKey('openrouter'));
  if (openrouterKey) {
    return {
      kind: 'openrouter',
      endpoint: MODEL_API_ENDPOINTS.openrouterDecisions,
      model: JEV_OPENROUTER_MODEL,
      apiKey: openrouterKey,
    };
  }
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
