import type {
  SurfaceExecutionErrorV1,
  SurfaceExecutionEventV1,
} from '../contract/surfaceExecution';

const SENSITIVE_KEY_PARTS = [
  'authorization',
  'auth',
  'authtoken',
  'token',
  'cookie',
  'cookies',
  'password',
  'passwd',
  'secret',
  'apikey',
  'storagestate',
  'keymaterial',
  'sessionkey',
  'relaytoken',
];
const SENSITIVE_INLINE = /\b(?:bearer\s+[a-z0-9._~+/=-]+|(?:api[_-]?key|token|password|secret|cookie)\s*[:=]\s*[^\s,;]+)/gi;
const CANARY_INLINE = /surface-secret-canary-[a-z0-9_-]+/gi;
const DATA_URL = /^data:[^,]+,/i;
const ABSOLUTE_PATH = /(?:\/Users\/[^\s"'`]+|\/private\/tmp\/[^\s"'`]+|\/tmp\/[^\s"'`]+|\/var\/folders\/[^\s"'`]+|\/Volumes\/[^\s"'`]+)/g;
const MAX_DEPTH = 8;

function redactString(value: string): string {
  if (DATA_URL.test(value)) return '[redacted-binary]';
  return value
    .replace(SENSITIVE_INLINE, '[redacted]')
    .replace(CANARY_INLINE, '[redacted-canary]')
    .replace(ABSOLUTE_PATH, '[redacted-path]');
}

function isSensitiveKey(keyHint: string): boolean {
  const normalized = keyHint.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return SENSITIVE_KEY_PARTS.some((part) => normalized === part || normalized.endsWith(part));
}

export function redactSurfaceExecutionValue(
  value: unknown,
  keyHint = '',
  depth = 0,
): unknown {
  if (isSensitiveKey(keyHint)) return '[redacted]';
  if (depth > MAX_DEPTH) return '[truncated]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => redactSurfaceExecutionValue(item, keyHint, depth + 1));
  }
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[key] = redactSurfaceExecutionValue(child, key, depth + 1);
  }
  return output;
}

export function sanitizeSurfaceExecutionErrorV1(
  error: SurfaceExecutionErrorV1,
): SurfaceExecutionErrorV1 {
  return redactSurfaceExecutionValue(error) as SurfaceExecutionErrorV1;
}

export function sanitizeSurfaceExecutionEventV1(
  event: SurfaceExecutionEventV1,
): SurfaceExecutionEventV1 {
  return redactSurfaceExecutionValue(event) as SurfaceExecutionEventV1;
}
