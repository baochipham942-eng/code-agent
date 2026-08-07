import os from 'node:os';
import { scrubString } from '../../../shared/observability/scrubEvent';

export type SessionPackagePrivacyLevel = 'shareable' | 'full_local';

const MAX_DEPTH = 24;

function sanitizeValue(value: unknown, homeDir: string, depth: number): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (typeof value === 'string') return scrubString(value, { homeDir });
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, homeDir, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, child]) => [key, sanitizeValue(child, homeDir, depth + 1)]));
}

/** Apply the package privacy policy to every newly projected surface. */
export function sanitizePackageValue<T>(
  value: T,
  privacyLevel: SessionPackagePrivacyLevel,
  homeDir = os.homedir(),
): T {
  if (privacyLevel === 'full_local') return value;
  return sanitizeValue(value, homeDir, 0) as T;
}

export function sanitizePackageText(
  value: string,
  privacyLevel: SessionPackagePrivacyLevel,
  homeDir = os.homedir(),
): string {
  if (privacyLevel === 'full_local') return value;
  return scrubString(value, { homeDir });
}

const SENSITIVE_CONFIG_KEY_PARTS = ['key', 'token', 'secret', 'password', 'credential'];

function isSensitiveConfigKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return SENSITIVE_CONFIG_KEY_PARTS.some((part) => normalized.includes(part));
}

/**
 * 按字段名（含 key/token/secret/password/credential 子串，大小写不敏感）整段抹除。
 * 用于 config.json 一类"字段名即敏感标记"的结构化配置导出——`sanitizePackageValue`
 * 只按值内容做正则脱敏，抓不住形如 `apiKey: "plain-looking-string"` 这种值本身不像
 * 密钥形态的字段，需要按 key 名先过一遍。
 */
export function redactSensitiveKeyedFields(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.map((item) => redactSensitiveKeyedFields(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
    key,
    isSensitiveConfigKey(key) ? '[REDACTED]' : redactSensitiveKeyedFields(child, depth + 1),
  ]));
}
