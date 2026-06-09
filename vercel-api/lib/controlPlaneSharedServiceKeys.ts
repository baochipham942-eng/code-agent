// ============================================================================
// 团队共享服务 key（搜索等非模型服务）：从 Supabase 读「会变的配置」，key 从 Vercel env 取。
// 表里只存服务名和 api_key_env；真实 key 不入库，只在控制面组装后按 entitlement 下发。
// ============================================================================

import * as crypto from 'node:crypto';
import type { SharedServiceKeyConfig, SharedServiceKeyName } from './controlPlanePayloads.js';

const SUPABASE_URL_ENV_NAMES = [
  'CONTROL_PLANE_SUPABASE_URL',
  'CODE_AGENT_CONTROL_PLANE_SUPABASE_URL',
  'SUPABASE_URL',
];

const SUPABASE_SERVICE_KEY_ENV_NAMES = [
  'CONTROL_PLANE_SUPABASE_SERVICE_ROLE_KEY',
  'CODE_AGENT_CONTROL_PLANE_SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
];

const SHARED_SERVICE_KEYS_TABLE = 'control_plane_shared_service_keys';
const SHARED_SERVICE_KEY_POOL_STATE_TABLE = 'control_plane_shared_service_key_pool_state';

const SHARED_SERVICE_KEYS_FROM_DB_ENV_NAMES = [
  'CONTROL_PLANE_SHARED_SERVICE_KEYS_FROM_DB',
  'CODE_AGENT_CONTROL_PLANE_SHARED_SERVICE_KEYS_FROM_DB',
];

const SUPPORTED_SHARED_SERVICE_KEYS = new Set<SharedServiceKeyName>([
  'brave',
  'exa',
  'openai',
  'perplexity',
  'tavily',
]);

function readEnv(env: NodeJS.ProcessEnv, names: string[]): string | null {
  for (const name of names) {
    const value = env[name];
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function isDbSourcingEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = readEnv(env, SHARED_SERVICE_KEYS_FROM_DB_ENV_NAMES);
  return value !== null && /^(1|true|yes|on)$/i.test(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asSharedService(value: unknown): SharedServiceKeyName | null {
  const service = asString(value);
  return service && SUPPORTED_SHARED_SERVICE_KEYS.has(service as SharedServiceKeyName)
    ? service as SharedServiceKeyName
    : null;
}

interface SharedServiceKeyRow {
  service?: unknown;
  display_name?: unknown;
  base_url?: unknown;
  required_capability?: unknown;
  api_key_env?: unknown;
}

interface SharedServiceKeyPoolStateRow {
  key_id?: unknown;
  disabled_reason?: unknown;
  disabled_until?: unknown;
}

interface ResolvedServiceKey {
  apiKey: string;
  keyId: string;
}

export interface LoadSharedServiceKeysOptions {
  /** Stable request-specific seed used to distribute pooled keys. Raw seed is never returned to clients. */
  selectionSeed?: string;
  now?: Date;
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function parseApiKeyPool(raw: string): string[] {
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return uniqueNonEmpty(parsed.filter((value): value is string => typeof value === 'string'));
    }
    if (
      parsed
      && typeof parsed === 'object'
      && Array.isArray((parsed as { keys?: unknown }).keys)
    ) {
      return uniqueNonEmpty(
        ((parsed as { keys: unknown[] }).keys).filter((value): value is string => typeof value === 'string'),
      );
    }
  } catch {
    // Fall through to line/comma parsing for single-key env vars and simple lists.
  }

  return uniqueNonEmpty(trimmed.split(/[\r\n,]+/g));
}

function parseEnvNameList(raw: string): string[] {
  return uniqueNonEmpty(raw.split(/[\s,]+/g));
}

function readServiceKeyEnvValues(env: NodeJS.ProcessEnv, rawEnvNames: string): string[] {
  return parseEnvNameList(rawEnvNames)
    .map((name) => readEnv(env, [name]))
    .filter((value): value is string => value !== null);
}

function getServiceKeyId(service: SharedServiceKeyName, apiKey: string): string {
  return crypto.createHash('sha256').update(`${service}:${apiKey}`).digest('hex').slice(0, 16);
}

function hashToIndex(seed: string, modulo: number): number {
  const hex = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12);
  return Number.parseInt(hex, 16) % modulo;
}

function getRotationBucket(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function resolvePooledServiceKey(
  service: SharedServiceKeyName,
  rawEnvValues: string[],
  disabledKeyIds: Set<string>,
  options: Required<LoadSharedServiceKeysOptions>,
): ResolvedServiceKey | null {
  const entries = uniqueNonEmpty(rawEnvValues.flatMap((rawEnvValue) => parseApiKeyPool(rawEnvValue)))
    .map((apiKey) => ({ apiKey, keyId: getServiceKeyId(service, apiKey) }))
    .filter((entry) => !disabledKeyIds.has(entry.keyId));
  if (entries.length === 0) {
    return null;
  }
  if (entries.length === 1) {
    return entries[0];
  }

  const seed = `${service}:${options.selectionSeed}:${getRotationBucket(options.now)}`;
  return entries[hashToIndex(seed, entries.length)];
}

function isCurrentlyDisabled(row: SharedServiceKeyPoolStateRow, now: Date): boolean {
  const disabledReason = asString(row.disabled_reason);
  const disabledUntil = asString(row.disabled_until);
  if (!disabledReason && !disabledUntil) {
    return false;
  }
  if (!disabledUntil) {
    return true;
  }
  const disabledUntilTime = Date.parse(disabledUntil);
  if (!Number.isFinite(disabledUntilTime)) {
    return true;
  }
  return disabledUntilTime > now.getTime();
}

async function loadDisabledPoolKeyIds(
  supabaseUrl: string,
  serviceKey: string,
  service: SharedServiceKeyName,
  now: Date,
): Promise<Set<string>> {
  try {
    const endpoint = new URL(`${supabaseUrl.replace(/\/+$/, '')}/rest/v1/${SHARED_SERVICE_KEY_POOL_STATE_TABLE}`);
    endpoint.searchParams.set('service', `eq.${service}`);
    endpoint.searchParams.set('select', 'key_id,disabled_reason,disabled_until');

    const response = await fetch(endpoint.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      return new Set();
    }
    const rows = await response.json().catch(() => null);
    if (!Array.isArray(rows)) {
      return new Set();
    }
    return new Set(
      rows
        .filter((row) => isCurrentlyDisabled(row as SharedServiceKeyPoolStateRow, now))
        .map((row) => asString((row as SharedServiceKeyPoolStateRow).key_id))
        .filter((keyId): keyId is string => keyId !== null),
    );
  } catch {
    return new Set();
  }
}

async function rowToServiceKey(
  row: SharedServiceKeyRow,
  env: NodeJS.ProcessEnv,
  supabaseUrl: string,
  serviceKey: string,
  options: Required<LoadSharedServiceKeysOptions>,
): Promise<SharedServiceKeyConfig | null> {
  const service = asSharedService(row.service);
  const apiKeyEnv = asString(row.api_key_env);
  if (!service || !apiKeyEnv) {
    return null;
  }

  const rawEnvValues = readServiceKeyEnvValues(env, apiKeyEnv);
  if (rawEnvValues.length === 0) {
    return null;
  }

  const disabledKeyIds = await loadDisabledPoolKeyIds(supabaseUrl, serviceKey, service, options.now);
  const resolved = resolvePooledServiceKey(service, rawEnvValues, disabledKeyIds, options);
  if (!resolved) {
    return null;
  }

  const displayName = asString(row.display_name);
  const baseUrl = asString(row.base_url);
  const requiredCapability = asString(row.required_capability);
  return {
    service,
    apiKey: resolved.apiKey,
    keyId: resolved.keyId,
    ...(baseUrl ? { baseUrl } : {}),
    ...(displayName ? { displayName } : {}),
    ...(requiredCapability ? { requiredCapability } : {}),
  };
}

/**
 * 从 Supabase 读启用的共享服务 key 配置，并从 Vercel env 注入真实 key。
 * - 返回 null：未启用/未配置 Supabase → 调用方保留 env-JSON 兜底。
 * - 返回数组（可能为空）：已启用 → DB 是唯一事实来源。
 */
export async function loadSharedServiceKeysFromStore(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadSharedServiceKeysOptions = {},
): Promise<SharedServiceKeyConfig[] | null> {
  if (!isDbSourcingEnabled(env)) {
    return null;
  }
  const url = readEnv(env, SUPABASE_URL_ENV_NAMES);
  const serviceKey = readEnv(env, SUPABASE_SERVICE_KEY_ENV_NAMES);
  if (!url || !serviceKey || typeof fetch !== 'function') {
    return null;
  }

  try {
    const endpoint = new URL(`${url.replace(/\/+$/, '')}/rest/v1/${SHARED_SERVICE_KEYS_TABLE}`);
    endpoint.searchParams.set('enabled', 'eq.true');
    endpoint.searchParams.set('select', 'service,display_name,base_url,required_capability,api_key_env');

    const response = await fetch(endpoint.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      return null;
    }
    const rows = await response.json().catch(() => null);
    if (!Array.isArray(rows)) {
      return [];
    }
    const resolvedOptions: Required<LoadSharedServiceKeysOptions> = {
      selectionSeed: options.selectionSeed?.trim() || 'default',
      now: options.now ?? new Date(),
    };
    const serviceKeys = await Promise.all(
      rows.map((row) => rowToServiceKey(row as SharedServiceKeyRow, env, url, serviceKey, resolvedOptions)),
    );
    return serviceKeys.filter((key): key is SharedServiceKeyConfig => key !== null);
  } catch {
    return null;
  }
}
