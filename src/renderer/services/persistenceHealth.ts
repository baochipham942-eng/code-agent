import type { BuildInfo, PersistenceHealth, WebHealthResponse } from '@shared/contract';
import { SQLITE_FTS, SQLITE_INTEGRITY } from '@shared/constants';
import { getApiBaseUrl, hasNativeBridge } from '../api/transport';

const FALLBACK_WARNING = '历史持久化不可用，当前只会话内有效。';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPersistenceHealth(value: unknown): value is PersistenceHealth {
  if (!isRecord(value)) return false;
  return (
    (value.status === 'available' || value.status === 'unavailable' || value.status === 'degraded' || value.status === 'recovered') &&
    (value.mode === 'database' || value.mode === 'memory') &&
    typeof value.durable === 'boolean' &&
    typeof value.message === 'string' &&
    typeof value.checkedAt === 'number'
  );
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function isBuildInfo(value: unknown): value is BuildInfo {
  if (!isRecord(value)) return false;
  return (
    typeof value.appName === 'string'
    && isNullableString(value.branch)
    && isNullableString(value.commit)
    && isNullableString(value.commitShort)
    && (typeof value.dirty === 'boolean' || value.dirty === null)
    && isNullableString(value.worktree)
    && (value.installedFrom === undefined || isNullableString(value.installedFrom))
    && typeof value.builtAt === 'string'
  );
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export function shouldShowPersistenceWarning(health: PersistenceHealth | null | undefined): health is PersistenceHealth {
  return Boolean(health && (!health.durable || health.status === 'degraded' || health.status === 'recovered'));
}

export function getPersistenceWarningText(health: PersistenceHealth | null | undefined): string {
  return health?.message?.trim() || FALLBACK_WARNING;
}

export interface PersistenceBannerCopy {
  title: string;
  degradedTitle: string;
  degradedFtsDisabled: string;
  degradedFtsReindexing: string;
  degradedQuickCheck: string;
  degradedLocal: string;
  recoveredTitle: string;
  recoveredBody: string;
  corruptNoBackup: string;
  restoreFailed: string;
  restoreLowDisk: string;
  reasonPrefix: string;
}

function parseRecoveredBackupTimestamp(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const prefix = `${SQLITE_INTEGRITY.RECOVERED_FROM_BACKUP}:`;
  if (!reason.startsWith(prefix)) return undefined;
  const stamp = reason.slice(prefix.length).trim();
  return stamp.length > 0 ? stamp : undefined;
}

export function describePersistenceBanner(
  health: PersistenceHealth,
  copy: PersistenceBannerCopy,
): { title: string; body: string } {
  if (health.status === 'recovered') {
    const timestamp = parseRecoveredBackupTimestamp(health.reason) ?? '';
    return {
      title: copy.recoveredTitle,
      body: copy.recoveredBody.replace('{timestamp}', timestamp),
    };
  }
  if (health.status === 'degraded') {
    // 稳定 code 一并亮出（main 上 FTS 降级已有 reason 后缀，合并后保持）
    const reason = health.reason ? `${copy.reasonPrefix}${health.reason}` : '';
    if (health.reason === SQLITE_FTS.DISABLED_REASON) {
      return { title: copy.degradedTitle, body: `${copy.degradedFtsDisabled}${reason}` };
    }
    if (health.reason === SQLITE_FTS.EMPTY_RECREATED_REASON) {
      return { title: copy.degradedTitle, body: `${copy.degradedFtsReindexing}${reason}` };
    }
    if (health.reason === SQLITE_INTEGRITY.QUICK_CHECK_FAILED) {
      return { title: copy.degradedTitle, body: `${copy.degradedQuickCheck}${reason}` };
    }
    if (health.reason === SQLITE_INTEGRITY.LOCAL_CORRUPT) {
      return { title: copy.degradedTitle, body: `${copy.degradedLocal}${reason}` };
    }
    if (health.reason === SQLITE_INTEGRITY.RESTORE_LOW_DISK) {
      return { title: copy.degradedTitle, body: `${copy.restoreLowDisk}${reason}` };
    }
    return { title: copy.degradedTitle, body: `${health.message}${reason}` };
  }
  if (health.status === 'unavailable' && health.reason === SQLITE_INTEGRITY.CORRUPT_NO_BACKUP) {
    return { title: copy.title, body: copy.corruptNoBackup };
  }
  if (health.status === 'unavailable' && health.reason === SQLITE_INTEGRITY.RESTORE_FAILED) {
    return { title: copy.title, body: copy.restoreFailed };
  }
  const reason = health.reason ? `${copy.reasonPrefix}${health.reason}` : '';
  return { title: copy.title, body: `${getPersistenceWarningText(health)}${reason}` };
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

export async function fetchWebBuildInfo(): Promise<BuildInfo | null> {
  const response = await fetch(`${normalizeBaseUrl(getApiBaseUrl())}/api/health`, {
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`health request failed: ${response.status}`);
  }

  const payload = await response.json() as Partial<WebHealthResponse>;
  return isBuildInfo(payload.build) ? payload.build : null;
}
