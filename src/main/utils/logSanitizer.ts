// ============================================================================
// Log Sanitizer — strips sensitive values before writing to logs / database
//
// Wraps the existing SensitiveDetector patterns and adds extra coverage for
// env-var style assignments (API_KEY=xxx, SECRET=xxx, …) and long base64
// strings that appear after key-like prefixes.
// ============================================================================

import { maskSensitiveData } from '../security/sensitiveDetector';

// ---------------------------------------------------------------------------
// Extra regex patterns not fully covered by sensitiveDetector
// ---------------------------------------------------------------------------

/** ENV-style assignments: API_KEY=value, SECRET=value, TOKEN=value, PASSWORD=value */
const ENV_VAR_PATTERN =
  /(API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|ACCESS_KEY)=\S+/gi;

/** Long base64-ish strings (>40 chars) following a key-like prefix such as "key:" or "secret=" */
const BASE64_AFTER_KEY =
  /(?<=(?:key|secret|token|credential|password|auth)[=:]\s*['"]?)[A-Za-z0-9+/=_-]{40,}/gi;

/**
 * Sanitize a single string for safe logging.
 *
 * 1. Runs the comprehensive SensitiveDetector (API keys, Bearer tokens, JWTs,
 *    private keys, DB connection strings, etc.)
 * 2. Applies additional regex replacements for env-var patterns and base64 blobs.
 */
export function sanitizeForLog(text: string): string {
  // First pass – the heavyweight detector
  let result = maskSensitiveData(text);

  // Second pass – env-var assignments
  result = result.replace(ENV_VAR_PATTERN, '$1=***');

  // Third pass – long base64-ish values after key-like prefixes
  result = result.replace(BASE64_AFTER_KEY, '***');

  return result;
}

/**
 * Deep-sanitize a plain object (typically tool args) for logging.
 * Recursively walks string values and applies `sanitizeForLog`.
 */
export function sanitizeObjectForLog(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      out[key] = sanitizeForLog(value);
    } else if (Array.isArray(value)) {
      out[key] = value.map((v) =>
        typeof v === 'string'
          ? sanitizeForLog(v)
          : v && typeof v === 'object'
            ? sanitizeObjectForLog(v as Record<string, unknown>)
            : v,
      );
    } else if (value && typeof value === 'object') {
      out[key] = sanitizeObjectForLog(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}
