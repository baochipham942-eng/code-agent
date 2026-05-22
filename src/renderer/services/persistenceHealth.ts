import type { PersistenceHealth, WebHealthResponse } from '@shared/contract';
import { getApiBaseUrl, hasNativeBridge } from '../api/transport';

const FALLBACK_WARNING = '历史持久化不可用，当前只会话内有效。';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPersistenceHealth(value: unknown): value is PersistenceHealth {
  if (!isRecord(value)) return false;
  return (
    (value.status === 'available' || value.status === 'unavailable') &&
    (value.mode === 'database' || value.mode === 'memory') &&
    typeof value.durable === 'boolean' &&
    typeof value.message === 'string' &&
    typeof value.checkedAt === 'number'
  );
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export function shouldShowPersistenceWarning(health: PersistenceHealth | null | undefined): health is PersistenceHealth {
  return Boolean(health && !health.durable);
}

export function getPersistenceWarningText(health: PersistenceHealth | null | undefined): string {
  return health?.message?.trim() || FALLBACK_WARNING;
}

export async function fetchWebPersistenceHealth(): Promise<PersistenceHealth | null> {
  if (hasNativeBridge()) return null;

  const response = await fetch(`${normalizeBaseUrl(getApiBaseUrl())}/api/health`, {
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`health request failed: ${response.status}`);
  }

  const payload = await response.json() as Partial<WebHealthResponse>;
  return isPersistenceHealth(payload.persistence) ? payload.persistence : null;
}
