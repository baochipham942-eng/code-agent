// ============================================================================
// Error Classifier - Categorise API and runtime errors into known classes
// ============================================================================

import type { ModelAuthFailureMarker, ModelUnavailableMarker } from '../../shared/contract/model';
import { hasInsufficientBalanceSignal } from '../../shared/utils/providerError';
import { getModelErrorStatus } from '../../shared/modelErrorDiagnostics';

/** 引擎侧「本地就没有 key」的自有错误码，与上游 401/403 归同一类。 */
export const MODEL_API_KEY_MISSING_CODE = 'MODEL_API_KEY_MISSING';

export type ErrorClass =
  | 'overflow'
  | 'rate_limit'
  | 'auth'
  | 'network'
  | 'unavailable'
  | 'quota_exhaustion'
  | 'content_policy'
  | 'malformed_response'
  | 'model_deprecated'
  | 'unknown';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function getStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as Record<string, unknown>;
  const s = e['status'] ?? e['statusCode'] ?? e['code'];
  if (typeof s === 'number') return s;
  return undefined;
}

function getMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    const e = error as Record<string, unknown>;
    const m = e['message'];
    if (typeof m === 'string') return m;
  }
  if (typeof error === 'string') return error;
  return '';
}

function getHeaders(error: unknown): Record<string, string> | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as Record<string, unknown>;
  const h = e['headers'];
  if (typeof h === 'object' && h !== null) return h as Record<string, string>;
  return undefined;
}

// --------------------------------------------------------------------------
// Status-code → class mappings
// --------------------------------------------------------------------------

const STATUS_MAP: Array<[number[], ErrorClass]> = [
  [[413], 'overflow'],
  [[402], 'quota_exhaustion'],
  [[429], 'rate_limit'],
  [[401, 403], 'auth'],
  [[500, 502, 503, 504], 'unavailable'],
];

// --------------------------------------------------------------------------
// Message pattern → class mappings (case-insensitive)
// --------------------------------------------------------------------------

const MESSAGE_PATTERNS: Array<[RegExp, ErrorClass]> = [
  [
    /context_length_exceeded|maximum context length|prompt is too long|request too large|token limit/i,
    'overflow',
  ],
  [/x-ratelimit-remaining.*\b0\b/i, 'quota_exhaustion'],
  [/content.?filter|content.?policy|safety|harmful|violat(?:es?|ion)|moderation/i, 'content_policy'],
  [/unexpected.?token|JSON\.parse|invalid json|SyntaxError|tool_use.*corrupt|malformed.*json/i, 'malformed_response'],
  [/unsupported\s+model|model.*(?:not.?found|not\s+supported|does not exist|deprecated|decommission|retired)|(?:deprecated|retired).*model/i, 'model_deprecated'],
  [/rate limit|too many requests|quota exceeded/i, 'rate_limit'],
  [/invalid_api_key|authentication_error|invalid token|unauthorized|forbidden/i, 'auth'],
  [/econnreset|econnrefused|etimedout|socket hang up|network error|fetch failed/i, 'network'],
  [/service unavailable|bad gateway|gateway timeout|internal server error/i, 'unavailable'],
];

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

/**
 * Classify an unknown error thrown by an API call or the agent loop into one
 * of the known error classes.  Status codes are checked first; message
 * patterns are used as fallback.
 */
/**
 * 「缺 key / 鉴权被拒」的结构化识别（批 X5 ③）。
 *
 * 与 classifyError 的区别是**只认结构化字段，不看 message**：这个结果会变成用户看到的
 * 那句人话，而 message 是上游自由文案（真机那句 `You didn't provide an API key...` 就是
 * OpenAI 自己的措辞）。按文本认必然漏，漏了还静默——所以生产者必须在 throw 处把
 * status / code 带上，认不出就退回兜底文案，绝不猜。
 *
 * 沿 cause 链上溯：重试包装、agent loop 包装都会把原始错误塞进 cause。
 */
export function getModelAuthFailureMarker(error: unknown): ModelAuthFailureMarker | undefined {
  let cursor = error;
  for (let depth = 0; depth < 4 && cursor && typeof cursor === 'object'; depth += 1) {
    const candidate = cursor as { code?: unknown; status?: unknown; provider?: unknown; model?: unknown; cause?: unknown };
    // AI SDK 的 APICallError 把 HTTP 码放在 statusCode，不是 status（build 45 真机：403 漏成兜底话）。
    const status = getModelErrorStatus(candidate);
    if (candidate.code === MODEL_API_KEY_MISSING_CODE || status === 401 || status === 403) {
      return {
        code: 'MODEL_AUTH',
        ...(typeof candidate.provider === 'string' && candidate.provider ? { provider: candidate.provider } : {}),
        ...(typeof candidate.model === 'string' && candidate.model ? { model: candidate.model } : {}),
      };
    }
    cursor = candidate.cause;
  }
  return undefined;
}

function identityFields(candidate: { provider?: unknown; model?: unknown }): { provider?: string; model?: string } {
  return {
    ...(typeof candidate.provider === 'string' && candidate.provider ? { provider: candidate.provider } : {}),
    ...(typeof candidate.model === 'string' && candidate.model ? { model: candidate.model } : {}),
  };
}

/**
 * 模型被供应商停用 / 不存在。认 classifyError === model_deprecated，或 400 Unsupported model / 404 指向模型。
 * 鉴权失败走 getModelAuthFailureMarker，这里让位。
 */
export function getModelUnavailableMarker(error: unknown): ModelUnavailableMarker | undefined {
  if (getModelAuthFailureMarker(error)) return undefined;
  let cursor = error;
  for (let depth = 0; depth < 4 && cursor && typeof cursor === 'object'; depth += 1) {
    const candidate = cursor as { provider?: unknown; model?: unknown; cause?: unknown };
    if (classifyError(candidate) === 'model_deprecated') {
      return { code: 'MODEL_UNAVAILABLE', ...identityFields(candidate) };
    }
    cursor = candidate.cause;
  }
  if (classifyError(error) === 'model_deprecated') return { code: 'MODEL_UNAVAILABLE' };
  return undefined;
}

export type AvailabilityKind = 'model' | 'auth' | 'network' | 'quota';
export type AvailabilityScope = 'model' | 'provider';
export type AvailabilityFailure = { scope: AvailabilityScope; kind: AvailabilityKind };

/** 把一次调用失败分成「只标这个模型」还是「标整家供应商」，给健康监控用。 */
export function resolveAvailabilityFailure(error: unknown): AvailabilityFailure | undefined {
  if (error == null) return undefined;
  // 余额/额度耗尽是供应商级，但不是密钥问题：标 quota（「余额或额度用完了」），别误导用户重填 key。
  if (classifyError(error) === 'quota_exhaustion') {
    return { scope: 'provider', kind: 'quota' };
  }
  if (getModelAuthFailureMarker(error) || classifyError(error) === 'auth') {
    return { scope: 'provider', kind: 'auth' };
  }
  if (getModelUnavailableMarker(error) || classifyError(error) === 'model_deprecated') {
    return { scope: 'model', kind: 'model' };
  }
  if (classifyError(error) === 'network' || classifyError(error) === 'unavailable') {
    return { scope: 'provider', kind: 'network' };
  }
  return undefined;
}

export function classifyError(error: unknown): ErrorClass {
  const status = getStatus(error);

  if (status !== undefined) {
    for (const [codes, cls] of STATUS_MAP) {
      if (codes.includes(status)) return cls;
    }

    // HTTP 404 + model-related keywords → model_deprecated
    if (status === 404) {
      const msg = getMessage(error);
      if (/model|engine|deployment/i.test(msg)) return 'model_deprecated';
    }

    // HTTP 400 + content policy keywords → content_policy
    if (status === 400) {
      const msg = getMessage(error);
      if (/content.?filter|content.?policy|safety|harmful|violat|moderation/i.test(msg)) return 'content_policy';
      // 「Unsupported model」是模型下线，不是 content policy，也不是笼统 400。
      // 不认 bare "unsupported"（会误伤 Unsupported value: temperature）。
      if (/unsupported\s+model/i.test(msg) || /model.*(?:not.?found|does not exist|not\s+supported)/i.test(msg)) {
        return 'model_deprecated';
      }
    }
  }

  // Check headers for quota exhaustion (x-ratelimit-remaining: 0)
  const headers = getHeaders(error);
  if (headers) {
    const remaining = headers['x-ratelimit-remaining'];
    if (remaining === '0') return 'quota_exhaustion';
  }

  const message = getMessage(error);
  if (hasInsufficientBalanceSignal(error)) return 'quota_exhaustion';
  for (const [pattern, cls] of MESSAGE_PATTERNS) {
    if (pattern.test(message)) return cls;
  }

  return 'unknown';
}
