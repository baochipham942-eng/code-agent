// ============================================================================
// Error Classifier - Categorise API and runtime errors into known classes
// ============================================================================

export type ErrorClass =
  | 'overflow'
  | 'rate_limit'
  | 'auth'
  | 'network'
  | 'unavailable'
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

// --------------------------------------------------------------------------
// Status-code → class mappings
// --------------------------------------------------------------------------

const STATUS_MAP: Array<[number[], ErrorClass]> = [
  [[413], 'overflow'],
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
  }

  const message = getMessage(error);
  for (const [pattern, cls] of MESSAGE_PATTERNS) {
    if (pattern.test(message)) return cls;
  }

  return 'unknown';
}
