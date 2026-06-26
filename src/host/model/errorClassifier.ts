// ============================================================================
// Error Classifier - Categorise API and runtime errors into known classes
// ============================================================================

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
  [/billing|payment required|insufficient_quota|credit|x-ratelimit-remaining.*\b0\b/i, 'quota_exhaustion'],
  [/content.?filter|content.?policy|safety|harmful|violat(?:es?|ion)|moderation/i, 'content_policy'],
  [/unexpected.?token|JSON\.parse|invalid json|SyntaxError|tool_use.*corrupt|malformed.*json/i, 'malformed_response'],
  [/model.*(?:not.?found|deprecated|decommission|retired|does not exist)|(?:deprecated|retired).*model/i, 'model_deprecated'],
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
    }
  }

  // Check headers for quota exhaustion (x-ratelimit-remaining: 0)
  const headers = getHeaders(error);
  if (headers) {
    const remaining = headers['x-ratelimit-remaining'];
    if (remaining === '0') return 'quota_exhaustion';
  }

  const message = getMessage(error);
  for (const [pattern, cls] of MESSAGE_PATTERNS) {
    if (pattern.test(message)) return cls;
  }

  return 'unknown';
}
