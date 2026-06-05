// ============================================================================
// 团队共享 provider（中转站）配置：从 Supabase 读「会变的配置」，key 从 Vercel env 取。
// 混合方案核心：表里没有 key（只有 api_key_env 变量名），控制面在这里把两者拼成完整 provider，
// 再交给 entitlement 网关按 subject 过滤后下发。key 因此从不入库、从不经客户端可达面。
// ============================================================================

import type { SharedProviderConfig } from './controlPlanePayloads.js';

const SUPABASE_URL_ENV_NAMES = [
  'CONTROL_PLANE_SUPABASE_URL',
  'CODE_AGENT_CONTROL_PLANE_SUPABASE_URL',
  'SUPABASE_URL',
];

// 读这张表必须用 service role（绕过 admin-only RLS）；不接受 anon key。
const SUPABASE_SERVICE_KEY_ENV_NAMES = [
  'CONTROL_PLANE_SUPABASE_SERVICE_ROLE_KEY',
  'CODE_AGENT_CONTROL_PLANE_SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
];

const SHARED_PROVIDERS_TABLE = 'control_plane_shared_providers';

// 显式 opt-in：只有打开此开关才从 DB 读共享 provider。不开 → 走 env-JSON 兜底，
// 不给未用此功能的部署平添 DB 往返，也不改既有 cloud_config 行为。
const SHARED_PROVIDERS_FROM_DB_ENV_NAMES = [
  'CONTROL_PLANE_SHARED_PROVIDERS_FROM_DB',
  'CODE_AGENT_CONTROL_PLANE_SHARED_PROVIDERS_FROM_DB',
];

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
  const value = readEnv(env, SHARED_PROVIDERS_FROM_DB_ENV_NAMES);
  return value !== null && /^(1|true|yes|on)$/i.test(value);
}

interface SharedProviderRow {
  id?: unknown;
  display_name?: unknown;
  base_url?: unknown;
  protocol?: unknown;
  billing_mode?: unknown;
  models?: unknown;
  required_capability?: unknown;
  api_key_env?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeModels(value: unknown): Array<{ id: string; label?: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ id: string; label?: string }> = [];
  for (const entry of value) {
    const id = asString((entry as { id?: unknown })?.id);
    if (!id) continue;
    const label = asString((entry as { label?: unknown })?.label);
    out.push(label ? { id, label } : { id });
  }
  return out;
}

/** 把一行 DB 配置 + 从 env 取到的 key，拼成完整 SharedProviderConfig；任一必需项缺失则返回 null（跳过）。 */
function rowToProvider(row: SharedProviderRow, env: NodeJS.ProcessEnv): SharedProviderConfig | null {
  const id = asString(row.id);
  const displayName = asString(row.display_name);
  const baseUrl = asString(row.base_url);
  const apiKeyEnv = asString(row.api_key_env);
  const models = normalizeModels(row.models);
  if (!id || !displayName || !baseUrl || !apiKeyEnv || models.length === 0) {
    return null;
  }
  // key 从 Vercel env 取（表里只存变量名）；env 里没配 → 无法下发，跳过这条。
  const apiKey = readEnv(env, [apiKeyEnv]);
  if (!apiKey) {
    return null;
  }
  const protocol = row.protocol === 'claude' ? 'claude' : 'openai';
  const billingMode = (['free', 'plan', 'payg', 'unknown'] as const)
    .find((m) => m === row.billing_mode) ?? 'unknown';
  const requiredCapability = asString(row.required_capability);
  return {
    id,
    displayName,
    baseUrl,
    apiKey,
    protocol,
    billingMode,
    models,
    ...(requiredCapability ? { requiredCapability } : {}),
  };
}

/**
 * 从 Supabase 读启用的共享 provider 配置，并从 Vercel env 注入 key。
 * - 返回 null：未配置 Supabase（URL/service key 缺）→ 调用方保留 env-JSON 里的 sharedProviders（向后兼容）。
 * - 返回数组（可能为空）：已配置 → DB 是唯一事实来源（空表=不下发任何共享 provider）。
 */
export async function loadSharedProvidersFromStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SharedProviderConfig[] | null> {
  if (!isDbSourcingEnabled(env)) {
    return null;
  }
  const url = readEnv(env, SUPABASE_URL_ENV_NAMES);
  const serviceKey = readEnv(env, SUPABASE_SERVICE_KEY_ENV_NAMES);
  if (!url || !serviceKey || typeof fetch !== 'function') {
    return null;
  }

  try {
    const endpoint = new URL(`${url.replace(/\/+$/, '')}/rest/v1/${SHARED_PROVIDERS_TABLE}`);
    endpoint.searchParams.set('enabled', 'eq.true');
    endpoint.searchParams.set(
      'select',
      'id,display_name,base_url,protocol,billing_mode,models,required_capability,api_key_env',
    );

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
    return rows
      .map((row) => rowToProvider(row as SharedProviderRow, env))
      .filter((p): p is SharedProviderConfig => p !== null);
  } catch {
    // 读 store 失败不应整体打挂 cloud_config；降级到 env-JSON 兜底。
    return null;
  }
}
