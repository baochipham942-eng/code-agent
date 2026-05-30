// ============================================================================
// Secret Redaction - small dependency-free helpers for logs and smoke output
// ============================================================================

const SENSITIVE_KEY_PARTS = [
  'apikey',
  'api_key',
  'password',
  'passwd',
  'pwd',
  'token',
  'secret',
  'authorization',
  'credential',
  'private',
  'bearer',
];

const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bsk-[A-Za-z0-9][A-Za-z0-9_*.-]{4,}/g, replacement: 'sk-***REDACTED***' },
  { pattern: /\bAIza[0-9A-Za-z_-]{20,}/g, replacement: 'AIza***REDACTED***' },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: 'Bearer ***REDACTED***' },
];

export function isSensitiveLogKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, '');
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part.replace(/_/g, '')));
}

export function redactSecrets(value: string): string {
  let redacted = value;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

export function sanitizeLogValue(value: unknown, key?: string): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return key && isSensitiveLogKey(key) ? '***REDACTED***' : redactSecrets(value);
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (value instanceof Date) {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSecrets(value.message),
      stack: value.stack ? redactSecrets(value.stack) : undefined,
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item));
  }

  const output: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    output[childKey] = isSensitiveLogKey(childKey)
      ? '***REDACTED***'
      : sanitizeLogValue(childValue, childKey);
  }
  return output;
}
