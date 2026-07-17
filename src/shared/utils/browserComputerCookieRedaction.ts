/**
 * ADR-041 P1 — cookie seed / storageState redaction helpers for Browser/Computer export.
 * Kept separate from browserComputerRedaction.ts to stay under max-lines debt gate.
 */

const COOKIE_VALUE_FIELD_KEYS = new Set([
  'value',
  'encrypted_value',
  'encryptedValue',
  'cookieValue',
]);

function looksLikeCookieRecord(value: Record<string, unknown>): boolean {
  const hasName = typeof value.name === 'string' && value.name.length > 0;
  const hasDomain =
    (typeof value.domain === 'string' && value.domain.length > 0)
    || (typeof value.host === 'string' && value.host.length > 0);
  const hasValueField = [...COOKIE_VALUE_FIELD_KEYS].some((field) => field in value);
  return hasValueField && (hasName || hasDomain);
}

/** Redact nested cookie value fields on Playwright-like cookie records only. */
export function redactCookieValueFieldsInRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (!looksLikeCookieRecord(value)) {
    return value;
  }
  const next: Record<string, unknown> = { ...value };
  for (const field of COOKIE_VALUE_FIELD_KEYS) {
    if (field in next) {
      next[field] = '[redacted]';
    }
  }
  return next;
}

/**
 * Strip cookie plaintext from JSON-ish strings (session export / tool summaries)
 * even when producers mis-emit seeds or storageState.
 */
export function redactBrowserCookiePayloadsInText(value: string): string {
  let redacted = value;
  redacted = redacted.replace(
    /("(?:encrypted_?value|cookieValue|keychainPassword|keyMaterial|authToken)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
    '$1"[redacted]"',
  );
  redacted = redacted.replace(
    /("name"\s*:\s*"(?:\\.|[^"\\])*"\s*,\s*"value"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
    '$1"[redacted]"',
  );
  redacted = redacted.replace(
    /("value"\s*:\s*)"(?:\\.|[^"\\])*"(\s*,\s*"(?:domain|host|path|expires|httpOnly|secure|sameSite)")/gi,
    '$1"[redacted]"$2',
  );
  redacted = redacted.replace(
    /("(?:domain|host)"\s*:\s*"(?:\\.|[^"\\])*"\s*,\s*"name"\s*:\s*"(?:\\.|[^"\\])*"\s*,\s*"value"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
    '$1"[redacted]"',
  );
  redacted = redacted.replace(
    /("name"\s*:\s*"(?:\\.|[^"\\])*"\s*,\s*"(?:domain|host)"\s*:\s*"(?:\\.|[^"\\])*"\s*,\s*"value"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
    '$1"[redacted]"',
  );
  return redacted;
}
