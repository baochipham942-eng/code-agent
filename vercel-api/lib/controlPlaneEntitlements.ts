import type { CloudConfigPayload } from './controlPlanePayloads.js';
import type { ControlPlaneRequestLike } from './controlPlaneEnvelope.js';
import {
  fetchControlPlaneResource,
  makeControlPlaneCacheKey,
  readCachedControlPlaneValue,
  writeControlPlaneCacheValue,
} from './controlPlaneResilience.js';

type EntitlementPolicy = NonNullable<CloudConfigPayload['entitlement']>;
type EntitlementStatus = EntitlementPolicy['status'];

interface ControlPlaneSubject {
  id: string;
  email?: string;
  source: 'server_token_map' | 'supabase_auth';
}

interface SubjectEntitlementMapping {
  subject: {
    id: string;
    email?: string;
  };
  entitlement: EntitlementPolicy;
}

type SubjectEntitlementMap = Record<string, SubjectEntitlementMapping>;

interface SupabaseAuthConfig {
  url: string;
  key: string;
  entitlementTable: string;
  entitlementUserIdColumn: string;
}

interface SupabaseAuthMode {
  shouldUse: boolean;
  config: SupabaseAuthConfig | null;
}

const SUPABASE_URL_ENV_NAMES = [
  'CONTROL_PLANE_SUPABASE_URL',
  'CODE_AGENT_CONTROL_PLANE_SUPABASE_URL',
  'SUPABASE_URL',
];

const SUPABASE_KEY_ENV_NAMES = [
  'CONTROL_PLANE_SUPABASE_SERVICE_ROLE_KEY',
  'CODE_AGENT_CONTROL_PLANE_SUPABASE_SERVICE_ROLE_KEY',
  'CONTROL_PLANE_SUPABASE_KEY',
  'CODE_AGENT_CONTROL_PLANE_SUPABASE_KEY',
  'CONTROL_PLANE_SUPABASE_ANON_KEY',
  'CODE_AGENT_CONTROL_PLANE_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_KEY',
  'SUPABASE_ANON_KEY',
];

const SUPABASE_ENTITLEMENT_REQUIRED_ENV_NAMES = [
  'CONTROL_PLANE_SUPABASE_ENTITLEMENT_REQUIRED',
  'CODE_AGENT_CONTROL_PLANE_SUPABASE_ENTITLEMENT_REQUIRED',
  'CONTROL_PLANE_ENTITLEMENT_SUPABASE_REQUIRED',
  'CODE_AGENT_CONTROL_PLANE_ENTITLEMENT_SUPABASE_REQUIRED',
];

const SUPABASE_ENTITLEMENT_TABLE_ENV_NAMES = [
  'CONTROL_PLANE_SUPABASE_ENTITLEMENT_TABLE',
  'CODE_AGENT_CONTROL_PLANE_SUPABASE_ENTITLEMENT_TABLE',
];

const SUPABASE_ENTITLEMENT_USER_ID_COLUMN_ENV_NAMES = [
  'CONTROL_PLANE_SUPABASE_ENTITLEMENT_USER_ID_COLUMN',
  'CODE_AGENT_CONTROL_PLANE_SUPABASE_ENTITLEMENT_USER_ID_COLUMN',
];

function readEnv(env: NodeJS.ProcessEnv, names: string[]): string | null {
  for (const name of names) {
    const value = env[name];
    if (value && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function readBooleanEnv(env: NodeJS.ProcessEnv, names: string[]): boolean {
  const value = readEnv(env, names);
  if (!value) {
    return false;
  }
  return /^(1|true|yes|required)$/i.test(value.trim());
}

function hasEnv(env: NodeJS.ProcessEnv, names: string[]): boolean {
  return readEnv(env, names) !== null;
}

function resolveSupabaseAuthMode(env: NodeJS.ProcessEnv): SupabaseAuthMode {
  const url = readEnv(env, SUPABASE_URL_ENV_NAMES);
  const key = readEnv(env, SUPABASE_KEY_ENV_NAMES);
  const explicitlyRequired = readBooleanEnv(env, SUPABASE_ENTITLEMENT_REQUIRED_ENV_NAMES);
  const hasSupabaseConfig = hasEnv(env, SUPABASE_URL_ENV_NAMES) && hasEnv(env, SUPABASE_KEY_ENV_NAMES);
  const entitlementTable = readEnv(env, SUPABASE_ENTITLEMENT_TABLE_ENV_NAMES)
    ?? 'control_plane_entitlements';
  const entitlementUserIdColumn = readEnv(env, SUPABASE_ENTITLEMENT_USER_ID_COLUMN_ENV_NAMES)
    ?? 'user_id';

  return {
    shouldUse: explicitlyRequired || hasSupabaseConfig,
    config: url && key ? { url, key, entitlementTable, entitlementUserIdColumn } : null,
  };
}

function getHeader(req: ControlPlaneRequestLike, name: string): string | null {
  const headers = req.headers ?? {};
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

function getBearerToken(req: ControlPlaneRequestLike): string | null {
  const value = getHeader(req, 'authorization');
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function readSubjectEntitlementMap(env: NodeJS.ProcessEnv): SubjectEntitlementMap | null {
  const raw = readEnv(env, [
    'CONTROL_PLANE_ENTITLEMENT_TOKEN_MAP_JSON',
    'CODE_AGENT_CONTROL_PLANE_ENTITLEMENT_TOKEN_MAP_JSON',
  ]);
  if (!raw) {
    return null;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('CONTROL_PLANE_ENTITLEMENT_TOKEN_MAP_JSON must be a JSON object.');
  }

  return parsed as SubjectEntitlementMap;
}

function isValidStatus(value: string): value is EntitlementStatus {
  return value === 'active' || value === 'trial' || value === 'expired' || value === 'revoked';
}

function isValidEntitlement(value: unknown): value is EntitlementPolicy {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const entitlement = value as Partial<EntitlementPolicy>;
  return Boolean(
    typeof entitlement.plan === 'string'
      && Array.isArray(entitlement.capabilities)
      && entitlement.capabilities.every((capability) => typeof capability === 'string')
      && typeof entitlement.status === 'string'
      && isValidStatus(entitlement.status),
  );
}

function isValidMapping(value: SubjectEntitlementMapping | undefined): value is SubjectEntitlementMapping {
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (!value.subject || typeof value.subject.id !== 'string' || value.subject.id.trim().length === 0) {
    return false;
  }
  return isValidEntitlement(value.entitlement);
}

function revokedEntitlement(reason: string): EntitlementPolicy {
  return {
    status: 'revoked',
    plan: 'unauthenticated',
    capabilities: [],
    reason,
  };
}

type SharedProvider = NonNullable<CloudConfigPayload['sharedProviders']>[number];
type SharedServiceKey = NonNullable<CloudConfigPayload['sharedServiceKeys']>[number];
type SharedProviderKey = NonNullable<CloudConfigPayload['sharedProviderKeys']>[number];
type CapabilityGatedSecret = SharedProvider | SharedServiceKey | SharedProviderKey;

/** 该 subject 的 entitlement 是否有权拿到这条共享密钥配置（含其 apiKey）。 */
function isEntitledToSharedSecret(
  item: CapabilityGatedSecret,
  entitlement: EntitlementPolicy | null,
): boolean {
  // team-wide：无 capability 门，所有「已通过鉴权」的 subject 都能拿到。
  if (!item.requiredCapability) {
    return true;
  }
  if (!entitlement) {
    return false;
  }
  if (entitlement.status !== 'active' && entitlement.status !== 'trial') {
    return false;
  }
  if (entitlement.capabilities.includes('*')) {
    return true;
  }
  return entitlement.capabilities.includes(item.requiredCapability);
}

/**
 * 按 entitlement 过滤 sharedProviders——无权的整条剥离（含 apiKey），密钥绝不下发给无权 subject。
 * entitlement=null 表示「无可信 entitlement」（开放模式无 builtin / fail-closed），此时只保留 team-wide。
 */
function filterSharedProviders(
  payload: CloudConfigPayload,
  entitlement: EntitlementPolicy | null,
): CloudConfigPayload {
  const shared = payload.sharedProviders;
  if (!shared || shared.length === 0) {
    return payload;
  }
  const allowed = shared.filter((provider) => isEntitledToSharedSecret(provider, entitlement));
  if (allowed.length === shared.length) {
    return payload;
  }
  if (allowed.length === 0) {
    const { sharedProviders: _removed, ...rest } = payload;
    return rest;
  }
  return { ...payload, sharedProviders: allowed };
}

/**
 * 按 entitlement 过滤 sharedServiceKeys——无权的整条剥离（含 apiKey），密钥绝不下发给无权 subject。
 * entitlement=null 表示「无可信 entitlement」（开放模式无 builtin / fail-closed），此时只保留 team-wide。
 */
function filterSharedServiceKeys(
  payload: CloudConfigPayload,
  entitlement: EntitlementPolicy | null,
): CloudConfigPayload {
  const shared = payload.sharedServiceKeys;
  if (!shared || shared.length === 0) {
    return payload;
  }
  const allowed = shared.filter((key) => isEntitledToSharedSecret(key, entitlement));
  if (allowed.length === shared.length) {
    return payload;
  }
  if (allowed.length === 0) {
    const { sharedServiceKeys: _removed, ...rest } = payload;
    return rest;
  }
  return { ...payload, sharedServiceKeys: allowed };
}

/**
 * 按 entitlement 过滤 sharedProviderKeys（内置 provider 托管 key）——无权的整条剥离（含 apiKey）。
 */
function filterSharedProviderKeys(
  payload: CloudConfigPayload,
  entitlement: EntitlementPolicy | null,
): CloudConfigPayload {
  const shared = payload.sharedProviderKeys;
  if (!shared || shared.length === 0) {
    return payload;
  }
  const allowed = shared.filter((key) => isEntitledToSharedSecret(key, entitlement));
  if (allowed.length === shared.length) {
    return payload;
  }
  if (allowed.length === 0) {
    const { sharedProviderKeys: _removed, ...rest } = payload;
    return rest;
  }
  return { ...payload, sharedProviderKeys: allowed };
}

function filterSharedSecrets(
  payload: CloudConfigPayload,
  entitlement: EntitlementPolicy | null,
): CloudConfigPayload {
  return filterSharedProviderKeys(
    filterSharedServiceKeys(filterSharedProviders(payload, entitlement), entitlement),
    entitlement,
  );
}

function applySubjectEntitlement(
  payload: CloudConfigPayload,
  subject: ControlPlaneSubject,
  entitlement: EntitlementPolicy,
): CloudConfigPayload {
  return filterSharedSecrets(
    {
      ...payload,
      subject,
      entitlement,
    },
    entitlement,
  );
}

function applyFailClosedEntitlement(payload: CloudConfigPayload, reason: string): CloudConfigPayload {
  // 鉴权失败/缺主体：剥离所有共享密钥（含 team-wide），不向未验证客户端下发任何 key。
  const {
    sharedProviders: _removedProviders,
    sharedServiceKeys: _removedServiceKeys,
    sharedProviderKeys: _removedProviderKeys,
    ...rest
  } = payload;
  return {
    ...rest,
    subject: undefined,
    entitlement: revokedEntitlement(reason),
  };
}

function readSupabaseSubject(value: unknown): ControlPlaneSubject | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const user = value as { id?: unknown; email?: unknown };
  if (typeof user.id !== 'string' || user.id.trim().length === 0) {
    return null;
  }
  const email = typeof user.email === 'string' && user.email.trim().length > 0
    ? user.email.trim()
    : undefined;
  return {
    id: user.id.trim(),
    ...(email ? { email } : {}),
    source: 'supabase_auth',
  };
}

function readSupabaseEntitlement(value: unknown): EntitlementPolicy | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const row = value as {
    status?: unknown;
    plan?: unknown;
    capabilities?: unknown;
    expiresAt?: unknown;
    expires_at?: unknown;
    reason?: unknown;
  };
  const entitlement = {
    status: row.status,
    plan: row.plan,
    capabilities: row.capabilities,
    expiresAt: typeof row.expiresAt === 'string' ? row.expiresAt : row.expires_at,
    reason: row.reason,
  };
  if (!isValidEntitlement(entitlement)) {
    return null;
  }
  return {
    status: entitlement.status,
    plan: entitlement.plan,
    capabilities: [...entitlement.capabilities],
    ...(typeof entitlement.expiresAt === 'string' && entitlement.expiresAt.trim().length > 0
      ? { expiresAt: entitlement.expiresAt }
      : {}),
    ...(typeof entitlement.reason === 'string' && entitlement.reason.trim().length > 0
      ? { reason: entitlement.reason }
      : {}),
  };
}

async function verifySupabaseAccessToken(
  token: string,
  config: SupabaseAuthConfig,
  env: NodeJS.ProcessEnv,
): Promise<ControlPlaneSubject | null> {
  if (typeof fetch !== 'function') {
    return null;
  }

  const cacheKey = makeControlPlaneCacheKey('supabase-auth-user', [config.url, config.key, token]);
  const cached = readCachedControlPlaneValue<ControlPlaneSubject | null>(cacheKey, env);
  if (cached.hit) {
    return cached.value ?? null;
  }

  try {
    const response = await fetchControlPlaneResource(cacheKey, `${config.url.replace(/\/+$/, '')}/auth/v1/user`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: config.key,
      },
    }, { env });
    if (!response) {
      return null;
    }
    if (!response.ok) {
      writeControlPlaneCacheValue(cacheKey, null, env);
      return null;
    }
    const subject = readSupabaseSubject(await response.json().catch(() => null));
    writeControlPlaneCacheValue(cacheKey, subject, env);
    return subject;
  } catch {
    return null;
  }
}

async function readSupabaseSubjectEntitlement(
  subject: ControlPlaneSubject,
  config: SupabaseAuthConfig,
  env: NodeJS.ProcessEnv,
): Promise<EntitlementPolicy | null> {
  if (typeof fetch !== 'function') {
    return null;
  }

  const cacheKey = makeControlPlaneCacheKey('supabase-entitlement', [
    config.url,
    config.key,
    config.entitlementTable,
    config.entitlementUserIdColumn,
    subject.id,
  ]);
  const cached = readCachedControlPlaneValue<EntitlementPolicy | null>(cacheKey, env);
  if (cached.hit) {
    return cached.value ?? null;
  }

  try {
    const url = new URL(
      `${config.url.replace(/\/+$/, '')}/rest/v1/${encodeURIComponent(config.entitlementTable)}`,
    );
    url.searchParams.set(config.entitlementUserIdColumn, `eq.${subject.id}`);
    url.searchParams.set('select', 'status,plan,capabilities,expires_at,reason');
    url.searchParams.set('limit', '1');

    const response = await fetchControlPlaneResource(cacheKey, url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.key}`,
        apikey: config.key,
        Accept: 'application/json',
      },
    }, { env });
    if (!response) {
      return null;
    }
    if (!response.ok) {
      writeControlPlaneCacheValue(cacheKey, null, env);
      return null;
    }
    const rows = await response.json().catch(() => null);
    if (!Array.isArray(rows)) {
      writeControlPlaneCacheValue(cacheKey, null, env);
      return null;
    }
    const entitlement = readSupabaseEntitlement(rows[0]);
    writeControlPlaneCacheValue(cacheKey, entitlement, env);
    return entitlement;
  } catch {
    return null;
  }
}

function applyTokenMapEntitlementGate(
  payload: CloudConfigPayload,
  token: string,
  tokenMap: SubjectEntitlementMap | null,
): CloudConfigPayload {
  const mapping = tokenMap?.[token];
  if (!isValidMapping(mapping)) {
    return applyFailClosedEntitlement(payload, 'invalid_verified_subject');
  }

  return applySubjectEntitlement(
    payload,
    {
      id: mapping.subject.id,
      ...(mapping.subject.email ? { email: mapping.subject.email } : {}),
      source: 'server_token_map',
    },
    mapping.entitlement,
  );
}

export function applyServerEntitlementGate(
  req: ControlPlaneRequestLike,
  payload: CloudConfigPayload,
  env: NodeJS.ProcessEnv = process.env,
): CloudConfigPayload {
  const tokenMap = readSubjectEntitlementMap(env);
  const authRequired = readBooleanEnv(env, [
    'CONTROL_PLANE_ENTITLEMENT_REQUIRED',
    'CODE_AGENT_CONTROL_PLANE_ENTITLEMENT_REQUIRED',
  ]);
  const supabaseAuth = resolveSupabaseAuthMode(env);

  if (!authRequired && !tokenMap && !supabaseAuth.shouldUse) {
    // 开放模式（无鉴权配置）：按 builtin entitlement 过滤共享 provider；
    // 无 builtin entitlement 时只保留 team-wide（capability 门控的需要鉴权才下发）。
    return filterSharedProviders(payload, payload.entitlement ?? null);
  }

  const token = getBearerToken(req);
  if (!token) {
    return applyFailClosedEntitlement(payload, 'missing_verified_subject');
  }

  if (supabaseAuth.shouldUse) {
    return applyFailClosedEntitlement(
      payload,
      supabaseAuth.config ? 'supabase_auth_requires_async_gate' : 'supabase_auth_unconfigured',
    );
  }

  return applyTokenMapEntitlementGate(payload, token, tokenMap);
}

export async function applyServerEntitlementGateAsync(
  req: ControlPlaneRequestLike,
  payload: CloudConfigPayload,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CloudConfigPayload> {
  const tokenMap = readSubjectEntitlementMap(env);
  const authRequired = readBooleanEnv(env, [
    'CONTROL_PLANE_ENTITLEMENT_REQUIRED',
    'CODE_AGENT_CONTROL_PLANE_ENTITLEMENT_REQUIRED',
  ]);
  const supabaseAuth = resolveSupabaseAuthMode(env);

  if (!authRequired && !tokenMap && !supabaseAuth.shouldUse) {
    // 开放模式（无鉴权配置）：按 builtin entitlement 过滤共享 provider；
    // 无 builtin entitlement 时只保留 team-wide（capability 门控的需要鉴权才下发）。
    return filterSharedProviders(payload, payload.entitlement ?? null);
  }

  const token = getBearerToken(req);
  if (!token) {
    return applyFailClosedEntitlement(payload, 'missing_verified_subject');
  }

  if (!supabaseAuth.shouldUse) {
    return applyTokenMapEntitlementGate(payload, token, tokenMap);
  }

  if (!supabaseAuth.config) {
    return applyFailClosedEntitlement(payload, 'supabase_auth_unconfigured');
  }

  const subject = await verifySupabaseAccessToken(token, supabaseAuth.config, env);
  if (!subject) {
    return applyFailClosedEntitlement(payload, 'invalid_verified_subject');
  }
  const entitlement = await readSupabaseSubjectEntitlement(subject, supabaseAuth.config, env);
  if (!entitlement) {
    return applyFailClosedEntitlement(payload, 'missing_supabase_entitlement');
  }

  return applySubjectEntitlement(
    payload,
    subject,
    entitlement,
  );
}
