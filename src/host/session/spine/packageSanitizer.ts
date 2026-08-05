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
