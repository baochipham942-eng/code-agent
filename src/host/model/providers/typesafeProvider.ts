// ============================================================================
// TypeSafe Jev（System One）provider —— 判断面专用，只暴露 systemOne
// ============================================================================
// POST {MODEL_API_ENDPOINTS.typesafeSystemOne}，body { state, model, questions }，
// 返回 { answers: { <qname>: { choice, confidence } | { noul } } }。一次请求里的
// 问题独立并行评估——问句与阈值全在 shared/constants/jevQuestions.ts，本文件不含判定。
//
// 边界（有意为之）：
// - 不实现聊天面 Provider.inference（死表面不建），不进聊天 provider 目录/模型目录。
// - key 只经 providerResolution 的 provider→env 映射（typesafe→TYPESAFE_API_KEY），
//   本文件不另写 process.env 读取。
// - 非 2xx / 超时 / JSON 形状不对 → 抛带 code 的 Error；fail-closed 动作由调用方
//   （permissionClassifier：回落 ask）决定，本层不做降级决策。
// ============================================================================

import { MODEL_API_ENDPOINTS } from '../../../shared/constants';
import {
  JEV_MODEL,
  JEV_TIMEOUT_MS,
  type JevAnswers,
  type JevQuestionSpec,
} from '../../../shared/constants/jevQuestions';
import { resolveProviderApiKey } from './providerResolution';

/** 抛错时挂在 Error.code 上的稳定码（调用方按码决定 warn 口径，不用于重试）。 */
const TYPESAFE_ERROR_CODES = {
  missingKey: 'TYPESAFE_KEY_MISSING',
  httpError: 'TYPESAFE_HTTP_ERROR',
  timeout: 'TYPESAFE_TIMEOUT',
  badShape: 'TYPESAFE_BAD_SHAPE',
} as const;

function fail(code: string, message: string): never {
  const error = new Error(`[typesafe] ${message}`) as Error & { code: string };
  error.code = code;
  throw error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
  const apiKey = resolveProviderApiKey({ provider: 'typesafe', model: JEV_MODEL });
  if (!apiKey) fail(TYPESAFE_ERROR_CODES.missingKey, 'TYPESAFE_API_KEY 未配置，Jev 判断面不可用');

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

  let response: Response;
  try {
    response = await fetch(MODEL_API_ENDPOINTS.typesafeSystemOne, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, model: JEV_MODEL, questions }),
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut || (options.signal?.aborted ?? false)) {
      fail(TYPESAFE_ERROR_CODES.timeout, `systemOne 超时（${timeoutMs}ms）或被外部中止`);
    }
    fail(TYPESAFE_ERROR_CODES.httpError, `systemOne 网络失败: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    fail(
      TYPESAFE_ERROR_CODES.httpError,
      `systemOne HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    fail(
      TYPESAFE_ERROR_CODES.badShape,
      `systemOne 响应不是 JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed) || !isRecord(parsed.answers)) {
    fail(TYPESAFE_ERROR_CODES.badShape, `systemOne 响应缺 answers 对象: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  return parsed.answers as JevAnswers;
}
